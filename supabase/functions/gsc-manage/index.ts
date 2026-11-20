// ============================================================================
//  gsc-manage — Google Search Console management for client sites
// ----------------------------------------------------------------------------
//  Uses the partner group's connected Google account (Team & access → Search
//  Console; GSC_REFRESH_<ACCOUNT> in Vault) — the same routing as pull-gsc:
//  44i's group → the "44i" account, every other group → "default".
//  The connection must carry the full scopes (webmasters + siteverification);
//  a read-only connection gets a clear "Reconnect" message.
//
//  Actions (POST JSON):
//    { action:"status",          client_id }  property, permission, sitemaps
//    { action:"setup",           client_id }  add the property if missing,
//          verify it (META tag — pushed to WordPress through the connector,
//          1.15+; otherwise the token is saved for the deploy file / manual
//          install), then submit the sitemaps
//    { action:"verify",          client_id }  retry verification only
//    { action:"submit_sitemaps", client_id }  find + submit the site's sitemaps
//    { action:"submit_all" }                  service role only: every active
//          client the account can manage (weekly cron); runs in the background
//
//  Auth: service role (cron, wp-events), or staff — status for any staff,
//  changes for account managers and admins.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const WMT = "https://www.googleapis.com/webmasters/v3";
const SV = "https://www.googleapis.com/siteVerification/v1";
const UA = "Mozilla/5.0 (compatible; 44i-seo-platform/1.0)";

const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const _keys = new Map<string, { v: string; at: number }>();
async function platformKey(name: string): Promise<string> {
  const hit = _keys.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v = "";
  try {
    const { data } = await admin().rpc("platform_key", { p_name: name });
    if (typeof data === "string") v = data;
  } catch { /* fall back to the function secret */ }
  v = v || Deno.env.get(name) || "";
  _keys.set(name, { v, at: Date.now() });
  return v;
}

class GscError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// ── Google access token for one connected account ────────────────────────
const _tok = new Map<string, { t: string; at: number }>();
async function googleToken(acct: string): Promise<string> {
  const hit = _tok.get(acct);
  if (hit && Date.now() - hit.at < 45 * 60_000) return hit.t;
  const label = acct === "44i" ? "44i" : "YourDigitalGroup";
  const refresh = await platformKey("GSC_REFRESH_" + acct.toUpperCase());
  if (!refresh) throw new GscError("not_connected", `The ${label} Google account isn't connected — Team & access → Search Console → Connect Google.`);
  const [id, secret] = await Promise.all([platformKey("GSC_OAUTH_CLIENT_ID"), platformKey("GSC_OAUTH_CLIENT_SECRET")]);
  if (!id || !secret) throw new GscError("no_oauth_client", "Google OAuth client ID/secret missing — add them in Team & access → API keys.");
  const r = await fetch(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: refresh }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new GscError("refresh_failed", `Google sign-in for the ${label} account expired (${j.error || r.status}) — Reconnect it in Team & access.`);
  const scopes = String(j.scope || "");
  if (scopes && (!/auth\/webmasters(\s|$)/.test(scopes) || !/siteverification/.test(scopes))) {
    throw new GscError("read_only", `The ${label} Google account is connected read-only — click Reconnect in Team & access → Search Console and approve "manage Search Console" and "Site Verification".`);
  }
  _tok.set(acct, { t: j.access_token, at: Date.now() });
  return j.access_token;
}

async function g(token: string, method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25_000),
  });
  const txt = await r.text();
  let j: any = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 200) }; }
  if (!r.ok) {
    const msg = String(j?.error?.message || j?.error || r.status);
    if (r.status === 403 && /insufficient.*scope/i.test(msg)) {
      throw new GscError("read_only", "The Google account is connected read-only — Reconnect it in Team & access → Search Console to allow managing properties.");
    }
    throw new GscError("google_" + r.status, msg.slice(0, 300));
  }
  return j;
}

// ── the client's site ────────────────────────────────────────────────────
const hostOf = (u: string) => { try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase(); } catch { return ""; } };
const bare = (h: string) => h.replace(/^www\./, "");
function publicHost(h: string) {
  return !!h && h.includes(".") && !/^(localhost|.*\.local|.*\.internal)$/.test(h) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !h.includes(":") && !h.startsWith("[");
}
// The address the site actually serves from (www vs bare, http vs https):
// a URL-prefix property must match it exactly.
async function siteOrigin(url: string): Promise<string> {
  const host = hostOf(url);
  const start = `https://${host}/`;
  try {
    const r = await fetch(start, { redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
    await r.body?.cancel();
    const f = new URL(r.url || start);
    if (bare(f.hostname.toLowerCase()) === bare(host)) return `${f.protocol}//${f.hostname.toLowerCase()}/`;
  } catch { /* unreachable: keep the configured host */ }
  return start;
}

function pickProperty(sites: any[], host: string, origin: string) {
  const b = bare(host);
  const entries = (sites || []).map((s: any) => ({ url: String(s.siteUrl || ""), perm: String(s.permissionLevel || "") }));
  const prefix = entries.filter((e) => /^https?:\/\//.test(e.url) && bare(hostOf(e.url)) === b);
  const exact = prefix.find((e) => e.url === origin);
  const domain = entries.find((e) => e.url.toLowerCase() === "sc-domain:" + b);
  const usable = (e?: { perm: string }) => !!e && e.perm !== "siteUnverifiedUser";
  // a usable exact URL property, else the domain property, else any match
  return (usable(exact) ? exact : null) || (usable(domain) ? domain : null) ||
    prefix.find((e) => usable(e)) || exact || domain || prefix[0] || null;
}
const canManage = (perm: string) => perm === "siteOwner" || perm === "siteFullUser";

// ── WordPress connector call (same transport as publish-wp) ──────────────
async function wpCall(host: string, key: string, path: string, payload: unknown) {
  const urls = [`https://${host}/wp-json/seo-platform/v1${path}`, `https://${host}/?rest_route=${encodeURIComponent(`/seo-platform/v1${path}`)}`];
  let last = "";
  for (const u of urls) {
    const r = await fetch(u, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
    const txt = await r.text();
    let j: any; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
    if (r.status >= 300 && r.status < 400) throw new Error(`WordPress redirected to ${r.headers.get("location") || "another URL"} — fix the client URL (www / https)`);
    if (r.status === 404 || j?.code === "rest_no_route" || (!r.ok && typeof j?.raw === "string" && /<html/i.test(j.raw))) { last = `${r.status}`; continue; }
    if (!r.ok) throw new Error(`WordPress ${r.status}: ${(j && (j.message || j.error)) || txt.slice(0, 160)}`);
    return j;
  }
  throw new Error(`the connector has no ${path} endpoint (${last}) — update the plugin to 1.15+`);
}

// ── sitemaps ─────────────────────────────────────────────────────────────
async function getText(url: string, max = 400_000): Promise<{ ok: boolean; url: string; text: string; type: string }> {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
    const type = String(r.headers.get("content-type") || "").toLowerCase();
    const text = r.ok ? (await r.text()).slice(0, max) : (await r.body?.cancel(), "");
    return { ok: r.ok, url: r.url || url, text, type };
  } catch { return { ok: false, url, text: "", type: "" }; }
}
const looksLikeSitemap = (t: string) => /<(urlset|sitemapindex)\b/i.test(t.slice(0, 5000));
function inProperty(property: string, url: string) {
  if (property.startsWith("sc-domain:")) {
    const d = property.slice(10).toLowerCase(), h = hostOf(url);
    return h === d || h.endsWith("." + d);
  }
  return url.startsWith(property);
}
async function findSitemaps(origin: string, property: string): Promise<string[]> {
  const found: string[] = [];
  const robots = await getText(origin + "robots.txt", 100_000);
  if (robots.ok) {
    for (const m of robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) {
      const u = m[1].trim();
      if (/^https?:\/\//i.test(u) && inProperty(property, u) && !found.includes(u)) found.push(u);
    }
  }
  if (!found.length) {
    for (const p of ["sitemap_index.xml", "wp-sitemap.xml", "sitemap.xml"]) {
      const r = await getText(origin + p);
      if (r.ok && looksLikeSitemap(r.text) && inProperty(property, r.url)) { found.push(r.url); break; }
    }
  }
  return found.slice(0, 5);
}

// ── per-client work ──────────────────────────────────────────────────────
async function loadClient(supa: any, id: string) {
  const { data: c, error } = await supa.from("clients")
    .select("id, name, url, status, wp_api_key, gsc_verification_token, gsc_sitemaps_submitted_at, partner_groups(gsc_account)")
    .eq("id", id).maybeSingle();
  if (error || !c) throw new GscError("not_found", "client not found");
  const host = hostOf(String(c.url || ""));
  if (!publicHost(host)) throw new GscError("bad_url", `client URL "${c.url}" is not a public website address`);
  const acct = (c as any).partner_groups?.gsc_account === "44i" ? "44i" : "default";
  return { c, host, acct };
}

async function status(supa: any, id: string) {
  const { c, host, acct } = await loadClient(supa, id);
  const token = await googleToken(acct);
  const origin = await siteOrigin(c.url);
  const { siteEntry } = await g(token, "GET", `${WMT}/sites`);
  const prop = pickProperty(siteEntry || [], host, origin);
  let sitemaps: any[] = [];
  if (prop && prop.perm !== "siteUnverifiedUser") {
    try { sitemaps = ((await g(token, "GET", `${WMT}/sites/${encodeURIComponent(prop.url)}/sitemaps`)).sitemap || []).map((s: any) => ({
      path: s.path, submitted: s.lastSubmitted || null, downloaded: s.lastDownloaded || null, pending: !!s.isPending,
      errors: Number(s.errors || 0), warnings: Number(s.warnings || 0),
      urls: (s.contents || []).reduce((n: number, x: any) => n + Number(x.submitted || 0), 0),
    })); } catch { /* restricted users can't list sitemaps */ }
  }
  await supa.from("clients").update({ gsc_property: prop?.url || null, gsc_permission: prop?.perm || null }).eq("id", c.id);
  return { ok: true, account: acct, origin, property: prop?.url || null, permission: prop?.perm || null,
    can_manage: !!prop && canManage(prop.perm), sitemaps, wordpress: !!c.wp_api_key,
    verification_token: c.gsc_verification_token || null };
}

async function submitSitemaps(supa: any, id: string, opts: { token?: string; property?: string; origin?: string } = {}) {
  const { c, host, acct } = await loadClient(supa, id);
  const token = opts.token || await googleToken(acct);
  const origin = opts.origin || await siteOrigin(c.url);
  let property = opts.property;
  if (!property) {
    const { siteEntry } = await g(token, "GET", `${WMT}/sites`);
    const prop = pickProperty(siteEntry || [], host, origin);
    if (!prop) throw new GscError("no_property", `No Search Console property for ${host} yet — use "Set up in Search Console" first.`);
    if (!canManage(prop.perm)) throw new GscError("no_permission", `The connected account is ${prop.perm.replace(/^site/, "").replace(/User$/, " user").toLowerCase()} on ${prop.url} — it needs Owner or Full access to submit sitemaps.`);
    property = prop.url;
  }
  const maps = await findSitemaps(origin, property);
  if (!maps.length) throw new GscError("no_sitemap", `No sitemap found on ${origin} (robots.txt, sitemap_index.xml, wp-sitemap.xml, sitemap.xml).`);
  const results: any[] = [];
  for (const m of maps) {
    try { await g(token, "PUT", `${WMT}/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(m)}`); results.push({ path: m, ok: true }); }
    catch (e) { results.push({ path: m, ok: false, error: String((e as Error).message || e).slice(0, 200) }); }
  }
  const okAny = results.some((r) => r.ok);
  await supa.from("clients").update({
    gsc_property: property, gsc_sitemaps: results,
    ...(okAny ? { gsc_sitemaps_submitted_at: new Date().toISOString(), gsc_manage_error: null } : { gsc_manage_error: results.map((r) => r.error).join("; ").slice(0, 400) }),
  }).eq("id", c.id);
  return { ok: okAny, property, sitemaps: results };
}

async function verify(supa: any, id: string, opts: { token?: string; origin?: string } = {}) {
  const { c, host, acct } = await loadClient(supa, id);
  const token = opts.token || await googleToken(acct);
  const origin = opts.origin || await siteOrigin(c.url);
  const site = { type: "SITE", identifier: origin };
  // 1. the META token for this account + URL
  const t = await g(token, "POST", `${SV}/token`, { site, verificationMethod: "META" });
  const content = (String(t.token || "").match(/content="([^"]+)"/) || [])[1] || "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(content)) throw new GscError("bad_token", "Google returned an unexpected verification token");
  await supa.from("clients").update({ gsc_verification_token: content }).eq("id", c.id);
  // 2. put it on the site through the connector, when there is one
  let placed = "";
  if (c.wp_api_key) {
    try { await wpCall(host, c.wp_api_key, "/verification", { google: content }); placed = "wordpress"; }
    catch (e) { placed = "wordpress_failed: " + String((e as Error).message || e).slice(0, 160); }
  }
  // 3. ask Google to check
  try {
    await g(token, "POST", `${SV}/webResource?verificationMethod=META`, { site });
  } catch (e) {
    const tag = `<meta name="google-site-verification" content="${content}" />`;
    return { ok: false, verified: false, property: origin, token: content, tag, placed,
      message: placed === "wordpress"
        ? `Google couldn't see the tag yet (${String((e as Error).message || e).slice(0, 120)}). A caching plugin may be serving an old page — clear the cache, then click Verify.`
        : (placed ? `Couldn't place the tag through WordPress (${placed.slice(18)}). ` : "") +
          `Add this tag to the site's <head> — or upload a fresh deploy file (it carries the tag) — then click Verify: ${tag}` };
  }
  await supa.from("clients").update({ gsc_property: origin, gsc_permission: "siteOwner", gsc_manage_error: null }).eq("id", c.id);
  return { ok: true, verified: true, property: origin, placed };
}

async function setup(supa: any, id: string) {
  const { c, host, acct } = await loadClient(supa, id);
  const token = await googleToken(acct);
  const origin = await siteOrigin(c.url);
  const { siteEntry } = await g(token, "GET", `${WMT}/sites`);
  let prop = pickProperty(siteEntry || [], host, origin);
  const steps: string[] = [];
  if (prop && canManage(prop.perm)) {
    steps.push(`Property ${prop.url} already set up (${prop.perm === "siteOwner" ? "owner" : "full access"}).`);
  } else {
    if (!prop || prop.url !== origin) {
      await g(token, "PUT", `${WMT}/sites/${encodeURIComponent(origin)}`);
      steps.push(`Added property ${origin}.`);
    }
    const v = await verify(supa, id, { token, origin });
    if (!v.verified) return { ...v, steps };
    steps.push(v.placed === "wordpress" ? "Verified (tag placed through the WordPress connector)." : "Verified.");
    prop = { url: origin, perm: "siteOwner" };
  }
  try {
    const s = await submitSitemaps(supa, id, { token, property: prop!.url, origin });
    steps.push(`Submitted ${s.sitemaps.filter((x: any) => x.ok).length} sitemap(s): ${s.sitemaps.map((x: any) => x.path).join(", ")}`);
    return { ok: true, verified: true, property: prop!.url, sitemaps: s.sitemaps, steps };
  } catch (e) {
    steps.push("Sitemaps: " + String((e as Error).message || e));
    return { ok: true, verified: true, property: prop!.url, steps };
  }
}

async function submitAll(supa: any) {
  const { data: rows } = await supa.from("clients").select("id, name").eq("status", "active").not("url", "is", null).order("name");
  const out = { submitted: 0, skipped: 0, failed: 0 };
  for (const r of rows || []) {
    try { await submitSitemaps(supa, r.id); out.submitted++; }
    catch (e) {
      const code = (e as GscError).code || "";
      if (["no_property", "no_permission", "not_connected", "read_only", "bad_url", "no_sitemap"].includes(code)) out.skipped++; else out.failed++;
      if (code !== "not_connected" && code !== "read_only") {
        await supa.from("clients").update({ gsc_manage_error: String((e as Error).message || e).slice(0, 400) }).eq("id", r.id);
      }
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log("gsc-manage submit_all", JSON.stringify(out));
  return out;
}

// ── caller gate ──────────────────────────────────────────────────────────
async function gate(req: Request, supa: any): Promise<{ service: boolean; role: string } | Response> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "sign in required" }, 401);
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  let claimService = false;
  try {
    const seg = jwt.split(".")[1] || "";
    const claims = JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(seg.length / 4) * 4, "=")));
    claimService = claims.role === "service_role" && (typeof claims.exp !== "number" || claims.exp * 1000 > Date.now());
  } catch { /* not a JWT */ }
  if ((svc && jwt === svc) || claimService) return { service: true, role: "service" };
  const { data } = await supa.auth.getUser(jwt);
  if (!data?.user) return json({ error: "sign in required" }, 401);
  const { data: p } = await supa.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (!p) return json({ error: "staff only" }, 403);
  return { service: false, role: String(p.role) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const supa = admin();
  const who = await gate(req, supa);
  if (who instanceof Response) return who;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "status");
  const id = String(body.client_id || "");
  try {
    if (action === "submit_all") {
      if (!who.service) return json({ error: "scheduler only" }, 403);
      const work = submitAll(supa);
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) { er.waitUntil(work); return json({ ok: true, background: true }, 202); }
      return json({ ok: true, ...(await work) });
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "client_id required" }, 400);
    if (action === "status") return json(await status(supa, id));
    if (!who.service && !["account_manager", "super_admin", "admin"].includes(who.role)) return json({ error: "account managers and admins only" }, 403);
    if (action === "setup") return json(await setup(supa, id));
    if (action === "verify") return json(await verify(supa, id));
    if (action === "submit_sitemaps") {
      // wp-events pings this on every publish: at most once an hour per client
      if (who.service && !body.force) {
        const { data: c } = await supa.from("clients").select("gsc_sitemaps_submitted_at").eq("id", id).maybeSingle();
        if (c?.gsc_sitemaps_submitted_at && Date.now() - new Date(c.gsc_sitemaps_submitted_at).getTime() < 3600_000) return json({ ok: true, skipped: "submitted within the hour" });
      }
      return json(await submitSitemaps(supa, id));
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const code = (e as GscError).code || "error";
    const msg = String((e as Error).message || e).slice(0, 400);
    if (id && code !== "not_found") await supa.from("clients").update({ gsc_manage_error: msg }).eq("id", id).then(() => {}, () => {});
    return json({ ok: false, error: msg, code }, code === "not_found" ? 404 : 200);
  }
});
