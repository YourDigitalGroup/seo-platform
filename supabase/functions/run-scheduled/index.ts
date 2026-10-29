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
//    (default 200, max 500).
//  - Service role only: pg_cron calls it with the service-role key from Vault.
//    The public anon key is also a valid JWT, so without this check anyone
//    could fire mass audits/report rebuilds.
//  - A client audited within the last 20h is skipped (idempotent when cron
//    overlaps or is fired manually). That is what makes the 11:20 catch-up
//    sweep (schedules.sql) safe: it only picks up clients the 11:00 run missed.
//  - The platform rate-limits function-to-function calls per invocation
//    (~30/min: "RateLimitError … Retry after 57175ms"). Throttled dispatches
//    wait out the stated delay and retry instead of silently skipping the
//    client for the day.
//  - Audit jobs whose worker died (CPU/wall-clock limit) are left 'running'
//    forever by the dead worker; each run marks ones older than 30 min as
//    'error' so the console stops showing them in progress.
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
const SCHED_VERSION = "1.3.0";   // echoed in every response so a stale deploy is self-evident
const STALE_JOB_MIN = 30;        // a background audit never legitimately runs this long
const MAX_RATE_RETRIES = 4;

// The gateway has already verified the JWT signature (verify_jwt); accept the
// exact service key, or a JWT whose role claim is service_role.
function isServiceRole(req: Request): boolean {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!tok) return false;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (svc && tok === svc) return true;
  try {
    const part = tok.split(".")[1] || "";
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return claims?.role === "service_role";
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!isServiceRole(req)) return json({ error: "service role only — fired by pg_cron (seop_invoke_scheduler)" }, 403);
  try {
    const { mode, limit } = await req.json().catch(() => ({}));
    if (mode !== "daily-audits" && mode !== "weekly-reports" && mode !== "daily-advice-local") {
      return json({ error: "mode must be daily-audits, weekly-reports or daily-advice-local" }, 400);
    }
    // Default cap covers the WHOLE roster (dispatches are fast 202s — the
    // audits run in their own background invocations), so "daily" really
    // means daily. The old default of 20/run silently turned a 60-client
    // roster into an every-3-days rotation. `limit` still overrides.
    const cap = Math.min(Math.max(1, Number(limit) || 200), 500);
    const base = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa = createClient(base, key, { auth: { persistSession: false } });

    // Separate Advice Local status-only sweep: never place orders or resync NAP.
    if (mode === "daily-advice-local") {
      const { data: linked, error: listErr } = await supa.from("clients")
        .select("id,url,al_client_id,status").not("al_client_id", "is", null)
        .eq("status", "active").order("name").limit(500);
      if (listErr) return json({ error: "could not list Advice Local clients", detail: listErr.message }, 500);
      const eligible = (linked || []).filter((c:any) => c.al_client_id != null);
      const { data: prev } = await supa.from("advice_local_directory_status")
        .select("client_id,fetched_at").in("client_id", eligible.map((c:any)=>c.id).length ? eligible.map((c:any)=>c.id) : ["00000000-0000-0000-0000-000000000000"])
        .order("fetched_at", {ascending:false}).limit(1000);
      const fresh = new Set<string>();
      for(const row of prev||[]) if(Date.now()-new Date(row.fetched_at).getTime()<20*3600000)fresh.add(row.client_id);
      const targets=eligible.filter((c:any)=>!fresh.has(c.id)).slice(0,Math.min(Math.max(1,Number(limit)||200),500));
      const stats={success:0,failed:0};
      const refresh=async()=>{
        // Keep the Advice Local partner API load gentle and do not mark a
        // client fresh unless the API call actually saved its snapshot.
        for(const c of targets){
          try {
            const res=await fetch(`${base}/functions/v1/advice-local`,{
              method:"POST",
              headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},
              body:JSON.stringify({action:"status",client_id:c.id}),
            });
            const body=await res.json().catch(()=>({}));
            if(!res.ok||body.ok!==true||body.reporting_saved!==true) {
              stats.failed++;console.error("daily-advice-local",c.id,res.status,JSON.stringify(body).slice(0,350));
            }else stats.success++;
          }catch(e){stats.failed++;console.error("daily-advice-local",c.id,String(e).slice(0,250));}
          await new Promise(r=>setTimeout(r,350));
        }
        console.log("daily-advice-local complete",JSON.stringify({eligible:eligible.length,targets:targets.length,...stats}));
      };
      const runtime=(globalThis as any).EdgeRuntime;
      if(runtime?.waitUntil)runtime.waitUntil(refresh());else await refresh();
      return json({ok:true,mode,version:SCHED_VERSION,dispatched:targets.length,skipped_fresh:eligible.length-targets.length});
    }

    // Reap audit jobs whose worker was killed mid-run (no finally ever ran).
    let reaped = 0;
    try {
      const { data: dead } = await supa.from("audit_jobs")
        .update({ status: "error", error: "worker stopped before finishing (platform time/CPU limit) — reaped by run-scheduled", finished_at: new Date().toISOString() })
        .in("status", ["running", "queued", "pending"])
        .lt("started_at", new Date(Date.now() - STALE_JOB_MIN * 60000).toISOString())
        .select("id");
      reaped = (dead || []).length;
      if (reaped) console.warn(`run-scheduled: reaped ${reaped} stale audit job(s)`);
    } catch (e) { console.error("run-scheduled: stale-job sweep failed", String(e)); }

    const { data: clients } = await supa.from("clients")
      .select("id, url, status").eq("status", "active").not("url", "is", null).limit(500);
    const active = (clients || []).filter((c: any) => String(c.url || "").trim() !== "");
    if (!active.length) return json({ ok: true, mode, version: SCHED_VERSION, dispatched: 0, note: "no active clients" });

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
    // background:true → run-audit (5.5.0+) answers fast and finishes in its
    // own invocation, so a slow site can't 504 out of the nightly rotation.
    // Older deployed engines ignore the flag and run synchronously as before.
    const bodyFor = (c: any) => mode === "daily-audits"
      ? { client_id: c.id, audit_only: true, background: true }
      : { client_id: c.id };

    // Dispatch with modest concurrency; completion happens in the target
    // functions' own invocations, so we only hand the pipeline to waitUntil.
    // A rate-limited call (thrown RateLimitError or HTTP 429) waits out the
    // platform's "Retry after N ms" and goes again.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const retryAfterMs = (msg: string) => {
      const m = /retry after\s+(\d+)\s*ms/i.exec(msg);
      return Math.min(Math.max(m ? Number(m[1]) + 1500 : 60000, 2000), 65000);
    };
    const stats = { ok: 0, failed: 0, rate_limited: 0 };
    const send = async (c: any) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(`${base}/functions/v1/${fn}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(bodyFor(c)),
          });
          const text = r.ok ? "" : (await r.text()).slice(0, 200);
          if (r.status === 429 && attempt < MAX_RATE_RETRIES) {
            stats.rate_limited++; await sleep(retryAfterMs(text + " " + (r.headers.get("retry-after") ? `retry after ${Number(r.headers.get("retry-after")) * 1000}ms` : ""))); continue;
          }
          if (!r.ok) { stats.failed++; console.error(mode, c.url, r.status, text); } else stats.ok++;
          return;
        } catch (e) {
          const msg = String((e as any)?.message || e);
          if (/rate ?limit/i.test(msg) && attempt < MAX_RATE_RETRIES) { stats.rate_limited++; await sleep(retryAfterMs(msg)); continue; }
          stats.failed++; console.error(mode, c.url, msg.slice(0, 200));
          return;
        }
      }
    };
    const dispatch = (async () => {
      const CONC = 5;
      for (let i = 0; i < targets.length; i += CONC) {
        await Promise.allSettled(targets.slice(i, i + CONC).map(send));
        // run-audit answers 202 in ~50ms, so back-to-back batches all land on
        // one worker; a short gap lets the platform spread them out
        if (i + CONC < targets.length) await sleep(2000);
      }
      console.log(`${mode}: dispatched ${targets.length} client(s) — ok ${stats.ok}, failed ${stats.failed}, rate-limit waits ${stats.rate_limited}`);
    })();
    const er = (globalThis as any).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(dispatch); else await dispatch;

    return json({ ok: true, mode, version: SCHED_VERSION, dispatched: targets.length, reaped_stale_jobs: reaped,
      clients: targets.map((c: any) => c.url),
      skipped_fresh: mode === "daily-audits" ? active.length - targets.length : undefined });
  } catch (e) {
    console.error("run-scheduled fatal", e);
    return json({ error: "unhandled", detail: String((e as any)?.stack || e).slice(0, 500) }, 500);
  }
});
