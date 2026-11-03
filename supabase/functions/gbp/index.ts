// ============================================================================
//  gbp: Google Business Profile performance for report page 1 ("Local
//  Listing Optimization": directions, website clicks, calls, Search / Maps
//  views by device, search terms).
// ----------------------------------------------------------------------------
//  Two Google sign-ins (gbp_connections): 44i Digital (media@44interactive.com)
//  and Your Digital Group (yourdigitalgroup@gmail.com). A Super Admin clicks
//  Connect in Team & access, signs in with Google, and gbp-callback stores
//  the refresh token in Vault (platform key GBP_REFRESH_<KEY>). After that:
//    discover   lists every listing each account manages and matches them to
//               clients (website, then exact name) → clients.gbp_location
//    collect    monthly totals → gbp_performance_monthly →
//               looker_llo_google_business_profile (Looker report page 1)
//  Needs a Google Cloud project approved for the Business Profile APIs (a
//  0-QPM quota means not approved yet) with the Business Profile Performance,
//  My Business Account Management and My Business Business Information APIs
//  enabled, and an OAuth web client whose redirect URI is the gbp-callback
//  function URL. Keys: GBP_OAUTH_CLIENT_ID, GBP_OAUTH_CLIENT_SECRET.
//
//  Actions (POST { action, ... }):
//    status                                  SA        connections, keys, matched clients
//    connect     { connection, return_to }   SA        Google sign-in URL
//    disconnect  { connection }              SA        revoke + forget the token
//    discover                                SA/service list listings, match clients
//    set_location { client_id, location|null } SA/AM   pin a client's listing by hand
//    collect_all { months? }                 SA/service monthly totals for every
//                                                       matched client (default: this
//                                                       month + last month)
//    collect     { client_id, months? }      any staff  the same for one client
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// ── Platform keys (Team & access → API keys). A key entered in the console is
// kept in Supabase Vault and wins; otherwise the function secret is used.
// Cached for a minute so a rotation reaches running workers quickly.
const _keys = new Map<string, { v: string; at: number }>();
async function platformKey(name: string): Promise<string> {
  const hit = _keys.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v = "";
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data } = await admin.rpc("platform_key", { p_name: name });
    if (typeof data === "string") v = data;
  } catch { /* Vault lookup unavailable: fall back to the function secret */ }
  v = v || Deno.env.get(name) || "";
  _keys.set(name, { v, at: Date.now() });
  return v;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const VERSION = "1.0.0";
const SCOPES = "openid email https://www.googleapis.com/auth/business.manage";
const CALLBACK = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/gbp-callback`;
const PERF = "https://businessprofileperformance.googleapis.com/v1";
const DAILY = ["BUSINESS_DIRECTION_REQUESTS", "WEBSITE_CLICKS", "CALL_CLICKS",
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"];

async function gateCaller(req: Request, roles?: string[]): Promise<{ userId: string | null; email: string; role: string } | Response> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!tok) return json({ error: "sign in required" }, 401);
  if (svc && tok === svc) return { userId: null, email: "", role: "service" };
  // pg_cron sends the Vault copy of the service key (a legacy JWT, which the
  // gateway's verify_jwt has already checked) — trust its role claim.
  try {
    const part = tok.split(".")[1] || "";
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (claims?.role === "service_role") return { userId: null, email: "", role: "service" };
  } catch { /* not a JWT */ }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, svc, { auth: { persistSession: false } });
  const { data } = await admin.auth.getUser(tok);
  if (!data?.user) return json({ error: "sign in required" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (!prof) return json({ error: "staff only — this account has no staff profile" }, 403);
  if (roles && !roles.includes(String(prof.role))) return json({ error: "your role can't do this" }, 403);
  return { userId: data.user.id, email: data.user.email || "", role: String(prof.role) };
}

const rootOf = (u: string) => String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(llc|inc|co|company|the)\b/g, " ").replace(/\s+/g, " ").trim();
const monthStart = (d: Date, add = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const refreshName = (key: string) => `GBP_REFRESH_${key.toUpperCase()}`;

// Access token for a connection, from its refresh token (cached ~50 min).
const _access = new Map<string, { t: string; exp: number }>();
async function accessToken(key: string): Promise<string> {
  const hit = _access.get(key);
  if (hit && hit.exp > Date.now()) return hit.t;
  const [id, secret, refresh] = [await platformKey("GBP_OAUTH_CLIENT_ID"), await platformKey("GBP_OAUTH_CLIENT_SECRET"), await platformKey(refreshName(key))];
  if (!id || !secret) throw new Error("no Google OAuth client — add GBP_OAUTH_CLIENT_ID and GBP_OAUTH_CLIENT_SECRET in Team & access → API keys");
  if (!refresh) throw new Error("this Google account isn't connected — click Connect in Team & access");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: refresh }), signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in expired or was revoked (${j.error || r.status}) — click Reconnect in Team & access`);
  _access.set(key, { t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 600_000 });
  return j.access_token;
}

async function google(key: string, url: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(key)}` }, signal: AbortSignal.timeout(30_000) });
    const txt = await r.text();
    let j: any = null; try { j = JSON.parse(txt); } catch { /* non-JSON */ }
    if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); continue; }
    if (!r.ok) {
      const msg = String(j?.error?.message || txt).slice(0, 220);
      // A project Google hasn't approved yet has a 0 QPM quota, which reads as 429.
      const hint = r.status === 429 ? " (if the Cloud project's Business Profile quota is 0, Google hasn't approved it yet)"
        : r.status === 403 && /has not been used|disabled/i.test(msg) ? " (enable this API in the Cloud project)" : "";
      throw new Error(`Google ${r.status}: ${msg}${hint}`);
    }
    return j || {};
  }
  throw new Error("Google kept refusing the request");
}

// Every listing a connected account can see.
async function listLocations(key: string) {
  const accounts: any[] = [];
  let tok = "";
  do {
    const j = await google(key, `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20${tok ? `&pageToken=${encodeURIComponent(tok)}` : ""}`);
    accounts.push(...(j.accounts || [])); tok = j.nextPageToken || "";
  } while (tok);
  const out: any[] = [];
  for (const a of accounts) {
    let t = "";
    do {
      const j = await google(key, `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,websiteUri,storefrontAddress&pageSize=100${t ? `&pageToken=${encodeURIComponent(t)}` : ""}`);
      for (const l of j.locations || []) out.push({ location: l.name, title: l.title || "", website: l.websiteUri || "",
        city: l.storefrontAddress?.locality || "", account: a.accountName || a.name, connection: key });
      t = j.nextPageToken || "";
    } while (t);
  }
  return out;
}

// Monthly totals for one listing: the seven daily metrics summed per month,
// plus that month's search terms.
async function collectClient(supa: any, c: any, months: Date[]) {
  const id = String(c.gbp_location || "").replace(/^locations\//, "");
  if (!id) throw new Error("no Business Profile listing matched yet");
  const first = months[months.length - 1], last = monthStart(months[0], 1);
  const end = new Date(Math.min(last.getTime() - 86400000, Date.now() - 86400000));
  const q = new URLSearchParams();
  for (const m of DAILY) q.append("dailyMetrics", m);
  const d = (p: string, x: Date) => { q.set(`dailyRange.${p}.year`, String(x.getUTCFullYear())); q.set(`dailyRange.${p}.month`, String(x.getUTCMonth() + 1)); q.set(`dailyRange.${p}.day`, String(x.getUTCDate())); };
  d("start_date", first); d("end_date", end);
  const perf = await google(c.gbp_connection, `${PERF}/locations/${id}:fetchMultiDailyMetricsTimeSeries?${q}`);
  const sums = new Map<string, Record<string, number>>();
  for (const m of months) sums.set(ymd(m), Object.fromEntries(DAILY.map((k) => [k, 0])));
  for (const s of perf.multiDailyMetricTimeSeries || []) for (const t of s.dailyMetricTimeSeries || []) {
    for (const v of t.timeSeries?.datedValues || []) {
      const key = ymd(new Date(Date.UTC(v.date.year, v.date.month - 1, 1)));
      const row = sums.get(key); if (row && t.dailyMetric in row) row[t.dailyMetric] += Number(v.value || 0);
    }
  }
  const rows = [];
  for (const m of months) {
    const terms: any[] = [];
    let tok = "";
    do {
      const k = new URLSearchParams({ "monthlyRange.start_month.year": String(m.getUTCFullYear()), "monthlyRange.start_month.month": String(m.getUTCMonth() + 1),
        "monthlyRange.end_month.year": String(m.getUTCFullYear()), "monthlyRange.end_month.month": String(m.getUTCMonth() + 1), pageSize: "100" });
      if (tok) k.set("pageToken", tok);
      const j = await google(c.gbp_connection, `${PERF}/locations/${id}/searchkeywords/impressions/monthly?${k}`);
      for (const s of j.searchKeywordsCounts || []) {
        const v = s.insightsValue || {};
        terms.push({ term: s.searchKeyword, impressions: v.value != null ? Number(v.value) : null, under: v.threshold != null ? Number(v.threshold) : null });
      }
      tok = terms.length < 300 ? j.nextPageToken || "" : "";
    } while (tok);
    terms.sort((a, b) => (b.impressions ?? b.under ?? 0) - (a.impressions ?? a.under ?? 0));
    const s = sums.get(ymd(m))!;
    rows.push({ client_id: c.id, report_month: ymd(m), location_id: c.gbp_location,
      directions_requests: s.BUSINESS_DIRECTION_REQUESTS, website_clicks: s.WEBSITE_CLICKS, call_clicks: s.CALL_CLICKS,
      desktop_maps_impressions: s.BUSINESS_IMPRESSIONS_DESKTOP_MAPS, desktop_search_impressions: s.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH,
      mobile_maps_impressions: s.BUSINESS_IMPRESSIONS_MOBILE_MAPS, mobile_search_impressions: s.BUSINESS_IMPRESSIONS_MOBILE_SEARCH,
      search_views: s.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH + s.BUSINESS_IMPRESSIONS_MOBILE_SEARCH,
      maps_views: s.BUSINESS_IMPRESSIONS_DESKTOP_MAPS + s.BUSINESS_IMPRESSIONS_MOBILE_MAPS,
      search_terms: terms, fetched_at: new Date().toISOString(), source: "google_business_profile_performance_api" });
  }
  const { error } = await supa.from("gbp_performance_monthly").upsert(rows, { onConflict: "client_id,report_month" });
  if (error) throw new Error(`saving: ${error.message}`);
  return rows.length;
}

const monthsBack = (n: number) => Array.from({ length: Math.max(1, Math.min(18, n)) }, (_, i) => monthStart(new Date(), -i));

async function eachClient(items: any[], fn: (c: any) => Promise<unknown>, conc = 3) {
  const stats = { ok: 0, failed: 0, errors: [] as string[] };
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) {
      const c = items[i++];
      try { await fn(c); stats.ok++; }
      catch (e) { stats.failed++; stats.errors.push(`${c.name}: ${String((e as any)?.message || e).slice(0, 160)}`); }
    }
  }));
  return stats;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const roles: Record<string, string[] | undefined> = {
    status: ["super_admin"], connect: ["super_admin"], disconnect: ["super_admin"],
    discover: ["super_admin"], collect_all: ["super_admin"],
    set_location: ["super_admin", "account_manager"], collect: undefined,
  };
  if (!(action in roles)) return json({ error: `unknown action "${action}"` }, 400);
  const who = await gateCaller(req, roles[action]);
  if (who instanceof Response) return who;
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    if (action === "status") {
      const { data: conns } = await supa.from("gbp_connections").select("*").order("key");
      const out = [];
      for (const c of conns || []) out.push({ ...c, connected: !!(await platformKey(refreshName(c.key))) });
      const { data: cl } = await supa.from("clients").select("id, gbp_location, gbp_connection").eq("status", "active");
      const { data: last } = await supa.from("gbp_performance_monthly").select("fetched_at").order("fetched_at", { ascending: false }).limit(1);
      return json({ ok: true, version: VERSION, callback_url: CALLBACK(),
        oauth_client_set: !!(await platformKey("GBP_OAUTH_CLIENT_ID")) && !!(await platformKey("GBP_OAUTH_CLIENT_SECRET")),
        connections: out, active_clients: (cl || []).length, matched_clients: (cl || []).filter((c: any) => c.gbp_location).length,
        last_fetched: last?.[0]?.fetched_at || null });
    }
    if (action === "connect") {
      const key = String(body.connection || "");
      const { data: conn } = await supa.from("gbp_connections").select("key, expected_email").eq("key", key).maybeSingle();
      if (!conn) return json({ error: "unknown connection" }, 400);
      const clientId = await platformKey("GBP_OAUTH_CLIENT_ID");
      if (!clientId || !(await platformKey("GBP_OAUTH_CLIENT_SECRET"))) return json({ error: "add the Google OAuth Client ID and Client Secret in API keys first" }, 400);
      const returnTo = String(body.return_to || "");
      if (returnTo && !/^https:\/\/[^\s]+$/i.test(returnTo)) return json({ error: "bad return address" }, 400);
      const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await supa.from("gbp_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
      await supa.from("gbp_oauth_states").insert({ state, connection: key, return_to: returnTo || null, created_by: who.email || null });
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({ client_id: clientId, redirect_uri: CALLBACK(), response_type: "code", scope: SCOPES,
        access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state,
        ...(conn.expected_email ? { login_hint: conn.expected_email } : {}) }).toString();
      return json({ ok: true, url: u.toString() });
    }
    if (action === "disconnect") {
      const key = String(body.connection || "");
      const refresh = await platformKey(refreshName(key));
      if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
      await supa.rpc("platform_key_set", { p_name: refreshName(key), p_value: "" });
      _keys.delete(refreshName(key)); _access.delete(key);
      await supa.from("gbp_connections").update({ account_email: null, connected_at: null, connected_by: null, last_error: null }).eq("key", key);
      return json({ ok: true });
    }
    if (action === "discover") {
      const { data: conns } = await supa.from("gbp_connections").select("key");
      const all: any[] = [], errors: string[] = [];
      for (const c of conns || []) {
        if (!(await platformKey(refreshName(c.key)))) continue;
        try {
          const locs = await listLocations(c.key);
          all.push(...locs);
          await supa.from("gbp_connections").update({ last_discovery_at: new Date().toISOString(), locations_found: locs.length, last_error: null }).eq("key", c.key);
        } catch (e) {
          const msg = String((e as any)?.message || e).slice(0, 300);
          errors.push(`${c.key}: ${msg}`);
          await supa.from("gbp_connections").update({ last_error: msg }).eq("key", c.key);
        }
      }
      // Match: the listing's website is the client's domain, else one exact name match.
      const { data: cl } = await supa.from("clients").select("id, name, url, gbp_location").eq("status", "active");
      let matched = 0;
      const unmatched: string[] = [];
      for (const c of cl || []) {
        const root = rootOf(c.url), n = norm(c.name);
        const bySite = all.filter((l) => root && rootOf(l.website) === root);
        const byName = all.filter((l) => n && norm(l.title) === n);
        const pick = bySite.length === 1 ? bySite[0] : bySite.length ? null : byName.length === 1 ? byName[0] : null;
        const keep = c.gbp_location && all.find((l) => l.location === c.gbp_location);
        const use = keep || pick;
        if (use) {
          matched++;
          await supa.from("clients").update({ gbp_location: use.location, gbp_location_title: use.title, gbp_connection: use.connection }).eq("id", c.id);
        } else unmatched.push(c.name);
      }
      return json({ ok: true, listings: all.length, matched, unmatched, errors,
        locations: all.map((l) => ({ location: l.location, title: l.title, city: l.city, website: l.website, connection: l.connection })) });
    }
    if (action === "set_location") {
      const cid = String(body.client_id || ""), loc = body.location ? String(body.location) : null, conn = body.connection ? String(body.connection) : null;
      if (loc && !/^locations\/\d+$/.test(loc)) return json({ error: "that doesn't look like a Business Profile location (locations/123…)" }, 400);
      const { error } = await supa.from("clients").update({ gbp_location: loc, gbp_location_title: loc ? String(body.title || "") || null : null, gbp_connection: loc ? conn : null }).eq("id", cid);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "collect_all") {
      const months = monthsBack(Number(body.months) || 2);
      const { data: cl } = await supa.from("clients").select("id, name, gbp_location, gbp_connection").eq("status", "active").not("gbp_location", "is", null);
      const list = (cl || []).filter((c: any) => c.gbp_connection);
      if (!list.length) return json({ ok: true, skipped: "no clients matched to a Business Profile listing yet", clients: 0 });
      const work = eachClient(list, (c) => collectClient(supa, c, months))
        .then(async (r) => {
          console.log("gbp collect_all", JSON.stringify(r).slice(0, 2000));
          await supa.from("gbp_connections").update({ last_sync_at: new Date().toISOString(), last_error: r.failed ? r.errors[0] : null }).neq("key", "");
        })
        .catch((e) => console.error("gbp collect_all", e));
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(work); else await work;
      return json({ ok: true, background: true, clients: list.length, months: months.length }, 202);
    }
    if (action === "collect") {
      const { data: c } = await supa.from("clients").select("id, name, gbp_location, gbp_connection").eq("id", String(body.client_id || "")).maybeSingle();
      if (!c) return json({ error: "client not found" }, 404);
      const n = await collectClient(supa, c, monthsBack(Number(body.months) || 2));
      return json({ ok: true, months: n });
    }
    return json({ error: "unhandled action" }, 400);
  } catch (e) {
    console.error("gbp", action, e);
    return json({ error: String((e as any)?.message || e).slice(0, 400) }, 500);
  }
});
