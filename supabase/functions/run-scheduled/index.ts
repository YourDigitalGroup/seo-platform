// ============================================================================
//  run-scheduled — the platform's clock.
// ----------------------------------------------------------------------------
//  Invoked by pg_cron (see supabase/migrations/schedules.sql):
//    · daily  → { "mode": "daily-audits" }   audit-only re-run per active
//               client (scores + history + verification; no new fixes/topics/
//               package — that stays the monthly campaign cycle).
//    · weekly → { "mode": "weekly-reports" } rebuilds the client progress
//               report for every active client's latest package, so the
//               white-label deliverable is never more than 7 days stale.
//
//  Design notes:
//  - Clients are processed least-recently-audited first and capped per run
//    (default 20), so a large roster rotates through cleanly even if a single
//    run can't cover everyone.
//  - A client audited within the last 20h is skipped (idempotent when cron
//    overlaps or is fired manually).
//  - Target invocations are dispatched and handed to the runtime's background
//    (EdgeRuntime.waitUntil) — each run-audit/generate-report call completes
//    in ITS OWN invocation server-side, so this dispatcher never times out
//    waiting on long audits.
//
//  Deploy: Edge Functions → run-scheduled.  Manual fire:
//    POST /functions/v1/run-scheduled  { "mode": "daily-audits", "limit": 5 }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const FRESH_HOURS = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { mode, limit } = await req.json().catch(() => ({}));
    if (mode !== "daily-audits" && mode !== "weekly-reports") {
      return json({ error: "mode must be daily-audits or weekly-reports" }, 400);
    }
    const cap = Math.min(Math.max(1, Number(limit) || 20), 60);
    const base = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa = createClient(base, key, { auth: { persistSession: false } });

    const { data: clients } = await supa.from("clients")
      .select("id, url, status").eq("status", "active").not("url", "is", null).limit(500);
    const active = (clients || []).filter((c: any) => String(c.url || "").trim() !== "");
    if (!active.length) return json({ ok: true, mode, dispatched: 0, note: "no active clients" });

    // Order least-recently-audited first; skip anything audited < FRESH_HOURS ago.
    const lastRun: Record<string, string> = {};
    {
      const { data: auds } = await supa.from("audits").select("client_id, run_at")
        .in("client_id", active.map((c: any) => c.id)).order("run_at", { ascending: false }).limit(2000);
      (auds || []).forEach((a: any) => { if (!lastRun[a.client_id]) lastRun[a.client_id] = a.run_at; });
    }
    const now = Date.now();
    let targets = active
      .map((c: any) => ({ ...c, last: lastRun[c.id] ? new Date(lastRun[c.id]).getTime() : 0 }))
      .sort((a: any, b: any) => a.last - b.last);
    if (mode === "daily-audits") {
      targets = targets.filter((c: any) => now - c.last > FRESH_HOURS * 3600 * 1000);
    } else {
      // weekly-reports: only clients that have ever been audited (a report needs a package)
      targets = targets.filter((c: any) => c.last > 0);
    }
    targets = targets.slice(0, cap);

    const fn = mode === "daily-audits" ? "run-audit" : "generate-report";
    const bodyFor = (c: any) => mode === "daily-audits"
      ? { client_id: c.id, audit_only: true }
      : { client_id: c.id };

    // Dispatch with modest concurrency; completion happens in the target
    // functions' own invocations, so we only hand the pipeline to waitUntil.
    const dispatch = (async () => {
      const CONC = 3;
      for (let i = 0; i < targets.length; i += CONC) {
        await Promise.allSettled(targets.slice(i, i + CONC).map((c: any) =>
          fetch(`${base}/functions/v1/${fn}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(bodyFor(c)),
          }).then(async (r) => { if (!r.ok) console.error(mode, c.url, r.status, (await r.text()).slice(0, 200)); })
            .catch((e) => console.error(mode, c.url, String(e)))
        ));
      }
      console.log(`${mode}: completed dispatch of ${targets.length} client(s)`);
    })();
    const er = (globalThis as any).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(dispatch); else await dispatch;

    return json({ ok: true, mode, dispatched: targets.length,
      clients: targets.map((c: any) => c.url),
      skipped_fresh: mode === "daily-audits" ? active.length - targets.length : undefined });
  } catch (e) {
    console.error("run-scheduled fatal", e);
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
});
