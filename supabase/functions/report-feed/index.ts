// ============================================================================
//  report-feed — the reporting views as CSV/JSON over HTTPS, for BI tools
//  that pull from a URL: TapClicks SmartConnectors, Looker Studio (when a
//  direct PostgreSQL connection isn't allowed), Sheets IMPORTDATA, etc.
// ----------------------------------------------------------------------------
//  GET /functions/v1/report-feed?token=…&view=audits[&format=csv][&group=…][&days=90]
//
//   · token   REQUIRED — must equal the REPORT_FEED_TOKEN function secret.
//             (Set a long random value: Edge Functions → report-feed →
//             Secrets. The token travels in the URL because SmartConnectors
//             can't send custom headers — treat the URL itself as a secret.)
//   · view    audits | clients | content | deliverables — the looker_* views
//             from supabase/migrations/looker_views.sql (run that first).
//             Whitelisted names only; nothing else is reachable.
//   · format  csv (default) | json
//   · group   optional partner-group name — a per-partner feed for
//             whitelabeled dashboards (exact match).
//   · days    audits view only — last N days of runs (default 365).
//
//  IMPORTANT deploy note: in the Supabase dashboard, turn OFF "Enforce JWT
//  verification" for THIS function (Edge Functions → report-feed → Details).
//  BI pullers can't send Supabase JWTs; the feed token is the gate instead.
//  The data exposed is exactly the whitelabel-safe view columns — no keys,
//  no intake PII, no raw tables.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const FEED_VERSION = "1.0.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const VIEWS: Record<string, { table: string; order: string; asc: boolean }> = {
  audits:       { table: "looker_audits",       order: "run_at",       asc: false },
  clients:      { table: "looker_clients",      order: "name",         asc: true  },
  content:      { table: "looker_content",      order: "created_at",   asc: false },
  deliverables: { table: "looker_deliverables", order: "month_offset", asc: true  },
};

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  try {
    const EXPECTED = (Deno.env.get("REPORT_FEED_TOKEN") || "").trim();
    if (!EXPECTED || EXPECTED.length < 16) {
      return json({ error: "feed not configured — set a REPORT_FEED_TOKEN secret (16+ chars) under Edge Functions → report-feed → Secrets" }, 500);
    }
    const u = new URL(req.url);
    const given = (u.searchParams.get("token") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
    if (given !== EXPECTED) return json({ error: "bad or missing token" }, 401);

    const viewKey = (u.searchParams.get("view") || "audits").toLowerCase();
    const view = VIEWS[viewKey];
    if (!view) return json({ error: `view must be one of: ${Object.keys(VIEWS).join(", ")}` }, 400);
    const format = (u.searchParams.get("format") || "csv").toLowerCase();
    const group = (u.searchParams.get("group") || "").trim();
    const days = Math.min(Math.max(1, Number(u.searchParams.get("days")) || 365), 3650);

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    let q = supa.from(view.table).select("*").order(view.order, { ascending: view.asc }).limit(50000);
    if (group) q = q.eq("partner_group", group);
    if (viewKey === "audits") q = q.gte("run_at", new Date(Date.now() - days * 86400000).toISOString());
    const { data, error } = await q;
    if (error) {
      const hint = /relation .* does not exist|does not exist/i.test(error.message || "")
        ? " — run supabase/migrations/looker_views.sql first" : "";
      return json({ error: error.message + hint }, 500);
    }
    const rows = data || [];

    if (format === "json") return json({ ok: true, view: viewKey, version: FEED_VERSION, rows: rows.length, data: rows });

    const cols = rows.length ? Object.keys(rows[0]) : ["empty"];
    const csv = [cols.join(",")]
      .concat(rows.map((r: any) => cols.map((c) => csvCell(r[c])).join(",")))
      .join("\r\n");
    return new Response(csv, { status: 200, headers: { ...CORS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `inline; filename="${view.table}.csv"`,
      "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("report-feed fatal", e);
    return json({ error: "unhandled", detail: String((e as any)?.message || e).slice(0, 300) }, 500);
  }
});
