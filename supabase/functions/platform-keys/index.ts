// ============================================================================
//  platform-keys: Team & access → API keys. Super Admins only.
// ----------------------------------------------------------------------------
//  Lists every API key the platform uses (what it powers, where it lives,
//  when it last changed and by whom), stores replacement keys in Supabase
//  Vault, and tests a key against its provider. Values never leave the
//  server: the console only ever sends a new value in, never reads one out.
//
//  Every Edge Function resolves keys with platformKey(name): the Vault copy
//  set here wins, otherwise the Edge Function secret of the same name.
//
//  Actions (POST { action, ... }):
//    list                       registry + status of every key
//    set    { name, value }     store / replace the key (Vault)
//    clear  { name }            remove the console copy (falls back to the secret)
//    test   { name }            check the key in use against its provider
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type KeyDef = { name: string; label: string; purpose: string; used_by: string[]; group: string; optional?: boolean; kind?: "json" };
const REGISTRY: KeyDef[] = [
  { name: "ANTHROPIC_API_KEY", group: "AI", label: "Anthropic (Claude)", purpose: "Writes content drafts, fixes and topic ideas; classifies businesses during audits; powers the WordPress plugin's AI auto-fix.", used_by: ["generate-content", "generate-fixes", "suggest-topics", "run-audit", "wp-ai"] },
  { name: "ANTHROPIC_WORKSPACE_ID", group: "AI", label: "Anthropic workspace ID", purpose: "Only needed when the Anthropic key isn't tied to a single workspace.", used_by: ["generate-content", "generate-fixes", "suggest-topics", "run-audit", "wp-ai"], optional: true },
  { name: "AHREFS_API_KEY", group: "SEO data", label: "Ahrefs", purpose: "Rankings, backlinks, competitors and site crawls for every audit; Brand Radar AI citation tracking.", used_by: ["run-audit", "brand-radar"] },
  { name: "GOOGLE_PLACES_API_KEY", group: "Google", label: "Google Places", purpose: "Google Business Profile data: rating, review count and reviews for reputation monitoring; address, phone and hours during audits.", used_by: ["reputation", "run-audit"] },
  { name: "PAGESPEED_API_KEY", group: "Google", label: "Google PageSpeed Insights", purpose: "Mobile performance scores and Core Web Vitals in audits.", used_by: ["run-audit"] },
  { name: "GSC_SERVICE_ACCOUNT", group: "Google", label: "Search Console service account (general)", purpose: "Pulls Search Console data for partner groups that use the general account. Paste the full service-account JSON file.", used_by: ["pull-gsc"], kind: "json" },
  { name: "GSC_SERVICE_ACCOUNT_44I", group: "Google", label: "Search Console service account (44i)", purpose: "Pulls Search Console data for 44i's own clients through Workspace delegation. Paste the full service-account JSON file.", used_by: ["pull-gsc"], kind: "json" },
  { name: "LOCAL_INCITE_API_KEY", group: "Reputation", label: "Local Incite token", purpose: "Reviews from Google, Facebook, Yelp and 80+ other sites (Local Incite runs on Shout About Us). Best: a Personal access token from Local Incite → API Keys. If you have app credentials instead, put the secret here and the ID below.", used_by: ["reputation"], optional: true },
  { name: "LOCAL_INCITE_API_ID", group: "Reputation", label: "Local Incite API ID", purpose: "Only for app credentials: the client / API ID that goes with the secret above. Not needed with a Personal access token.", used_by: ["reputation"], optional: true },
  { name: "ADVICE_LOCAL_API_KEY", group: "Listings", label: "Advice Local", purpose: "LLO listing sync, orders and fulfillment status.", used_by: ["advice-local"] },
  { name: "TRELLO_KEY", group: "Workflow", label: "Trello API key", purpose: "Specialist hand-off cards and approval comments (with the Trello token).", used_by: ["trello"] },
  { name: "TRELLO_TOKEN", group: "Workflow", label: "Trello token", purpose: "Authorizes the Trello API key on the 44i board.", used_by: ["trello"] },
  { name: "PEXELS_API_KEY", group: "Content", label: "Pexels", purpose: "Stock photo picker in the draft editor (featured images, Business Profile post photos).", used_by: ["image-search"], optional: true },
  { name: "REPORT_FEED_TOKEN", group: "Reporting", label: "Report feed token", purpose: "Lets Looker Studio / TapClicks read the report feed. Any random string of 16+ characters you choose.", used_by: ["report-feed"] },
];
const BY_NAME = new Map(REGISTRY.map((k) => [k.name, k]));

async function callerIsSuperAdmin(req: Request, admin: any): Promise<{ id: string; email: string } | Response> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!tok) return json({ error: "sign in required" }, 401);
  const { data } = await admin.auth.getUser(tok);
  if (!data?.user) return json({ error: "sign in required" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (prof?.role !== "super_admin") return json({ error: "Super Admins only" }, 403);
  return { id: data.user.id, email: data.user.email || "" };
}

async function effectiveKey(admin: any, name: string): Promise<string> {
  const { data } = await admin.rpc("platform_key", { p_name: name });
  return (typeof data === "string" && data) || Deno.env.get(name) || "";
}

// Local Incite is a white label of Shout About Us. A Personal access token is
// sent as a Bearer token; app credentials (ID + secret) are tried as an OAuth
// client-credentials grant. Returns a working bearer token, or why not.
const SAU = "https://production-api.shoutaboutus.com";
async function localInciteToken(admin: any, key?: string, id?: string): Promise<{ token?: string; how?: string; who?: string; detail: string }> {
  key = key ?? await effectiveKey(admin, "LOCAL_INCITE_API_KEY");
  id = id ?? await effectiveKey(admin, "LOCAL_INCITE_API_ID");
  if (!key) return { detail: "No Local Incite token or secret is set." };
  const verify = async (tok: string) => {
    const r = await fetch(`${SAU}/api/v1/verify-token`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const b = await r.text(); let who = "";
    try { const j = JSON.parse(b); const u = j?.data?.user || j?.user || j?.data || {}; who = String(u.email || u.name || ""); } catch { /* shape varies */ }
    return { ok: r.ok, status: r.status, who };
  };
  const v = await verify(key);
  if (v.ok) return { token: key, how: "personal access token", who: v.who, detail: "" };
  if (!id) return { detail: `Shout About Us ${v.status}: this isn't a Personal access token. In Local Incite open API Keys → Personal access token → Generate token and paste that here — or, if you were given an API ID with it, add the ID in the slot below.` };
  for (const [cid, sec] of [[id, key], [key, id]]) {
    const r = await fetch(`${SAU}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: sec }), signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) {
      const w = await verify(j.access_token);
      if (w.ok) return { token: j.access_token, how: "app credentials", who: w.who, detail: "" };
      return { detail: `Shout About Us issued a token from the app credentials but rejected it (${w.status}). App credentials sign in on behalf of a user; ask Local Incite for a Personal access token instead.` };
    }
    if (cid === key) return { detail: `Shout About Us didn't accept the ID + secret (${r.status}: ${String(j?.error_description || j?.message || j?.error || "").slice(0, 160)}). App credentials need a user sign-in; generate a Personal access token in Local Incite → API Keys instead.` };
  }
  return { detail: "Local Incite rejected the credentials." };
}

// A cheap, read-only call per provider. Returns ok + a plain-English detail.
async function testKey(def: KeyDef, value: string, admin: any): Promise<{ ok: boolean; detail: string }> {
  const t = AbortSignal.timeout(25_000);
  const http = async (url: string, init: RequestInit = {}) => {
    const r = await fetch(url, { ...init, signal: t });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  };
  const why = (b: string) => { try { const j = JSON.parse(b); return String(j?.error?.message || j?.error || j?.message || b).slice(0, 200); } catch { return b.slice(0, 200); } };
  switch (def.name) {
    case "ANTHROPIC_API_KEY": {
      const ws = await effectiveKey(admin, "ANTHROPIC_WORKSPACE_ID");
      const r = await http("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": value, "anthropic-version": "2023-06-01", ...(ws ? { "anthropic-workspace-id": ws } : {}) } });
      return r.ok ? { ok: true, detail: "Anthropic accepted the key." } : { ok: false, detail: `Anthropic ${r.status}: ${why(r.body)}` };
    }
    case "AHREFS_API_KEY": {
      const r = await http("https://api.ahrefs.com/v3/subscription-info/limits-and-usage", { headers: { Authorization: `Bearer ${value}`, Accept: "application/json" } });
      if (!r.ok) return { ok: false, detail: `Ahrefs ${r.status}: ${why(r.body)}` };
      let extra = ""; try { const j = JSON.parse(r.body)?.limits_and_usage || {}; if (j.units_usage_api_key != null) extra = ` Units used this month: ${Number(j.units_usage_api_key).toLocaleString()}${j.units_limit_api_key ? ` of ${Number(j.units_limit_api_key).toLocaleString()}` : ""}.`; } catch { /* shape varies */ }
      return { ok: true, detail: `Ahrefs accepted the key.${extra}` };
    }
    case "GOOGLE_PLACES_API_KEY": {
      const r = await http("https://places.googleapis.com/v1/places:searchText", { method: "POST",
        headers: { "X-Goog-Api-Key": value, "X-Goog-FieldMask": "places.id", "Content-Type": "application/json" },
        body: JSON.stringify({ textQuery: "Googleplex Mountain View CA" }) });
      return r.ok ? { ok: true, detail: "Places API (New) accepted the key." }
        : { ok: false, detail: `Google ${r.status}: ${why(r.body)}${r.status === 403 ? " — enable “Places API (New)” on the key's Google Cloud project and allow it in the key's API restrictions." : ""}` };
    }
    case "PAGESPEED_API_KEY": {
      const r = await http(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent("https://example.com/")}&category=performance&strategy=mobile&key=${encodeURIComponent(value)}`);
      return r.ok ? { ok: true, detail: "PageSpeed Insights accepted the key." }
        : { ok: false, detail: `Google ${r.status}: ${why(r.body)}${r.status === 403 ? " — enable the PageSpeed Insights API on the key's Google Cloud project." : ""}` };
    }
    case "GSC_SERVICE_ACCOUNT": case "GSC_SERVICE_ACCOUNT_44I": {
      try { const j = JSON.parse(value); return j.client_email && j.private_key ? { ok: true, detail: `Valid service-account file for ${j.client_email}.` } : { ok: false, detail: "The JSON is missing client_email or private_key." }; }
      catch { return { ok: false, detail: "Not valid JSON — paste the whole service-account .json file." }; }
    }
    case "ADVICE_LOCAL_API_KEY": {
      const r = await http("https://api.advicelocal.com/legacyclients?limit=1", { headers: { "x-api-token": value, Accept: "application/json" } });
      return r.ok ? { ok: true, detail: "Advice Local accepted the key." } : { ok: false, detail: `Advice Local ${r.status}: ${why(r.body)}` };
    }
    case "TRELLO_KEY": case "TRELLO_TOKEN": {
      const key = def.name === "TRELLO_KEY" ? value : await effectiveKey(admin, "TRELLO_KEY");
      const tok = def.name === "TRELLO_TOKEN" ? value : await effectiveKey(admin, "TRELLO_TOKEN");
      if (!key || !tok) return { ok: false, detail: "Trello needs both the API key and the token." };
      const r = await http(`https://api.trello.com/1/members/me?fields=username&key=${encodeURIComponent(key)}&token=${encodeURIComponent(tok)}`);
      if (!r.ok) return { ok: false, detail: `Trello ${r.status}: ${r.body.slice(0, 160)}` };
      let u = ""; try { u = JSON.parse(r.body).username; } catch { /* ignore */ }
      return { ok: true, detail: `Trello accepted the key and token${u ? ` (signed in as @${u})` : ""}.` };
    }
    case "PEXELS_API_KEY": {
      const r = await http("https://api.pexels.com/v1/search?query=office&per_page=1", { headers: { Authorization: value } });
      return r.ok ? { ok: true, detail: "Pexels accepted the key." } : { ok: false, detail: `Pexels ${r.status}: ${why(r.body)}` };
    }
    case "LOCAL_INCITE_API_KEY": case "LOCAL_INCITE_API_ID": {
      const r = await localInciteToken(admin, def.name === "LOCAL_INCITE_API_KEY" ? value : undefined, def.name === "LOCAL_INCITE_API_ID" ? value : undefined);
      return r.token ? { ok: true, detail: `Local Incite accepted it (${r.how})${r.who ? ` — signed in as ${r.who}` : ""}.` } : { ok: false, detail: r.detail };
    }
    case "REPORT_FEED_TOKEN":
      return value.trim().length >= 16 ? { ok: true, detail: "Token is set and long enough." } : { ok: false, detail: "Use at least 16 characters." };
    default:
      return { ok: !!value, detail: value ? "Saved. There's no automatic test for this key yet." : "Not set." };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const who = await callerIsSuperAdmin(req, admin);
  if (who instanceof Response) return who;
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const log = (key_name: string, act: string, ok: boolean | null, detail: string | null) =>
      admin.from("platform_key_events").insert({ key_name, action: act, ok, detail, actor_id: who.id, actor_email: who.email });

    if (action === "list") {
      const { data: meta, error: mErr } = await admin.rpc("platform_key_meta");
      if (mErr) return json({ error: `key storage unavailable — run platform_keys_reputation.sql (${mErr.message})` }, 500);
      const vault = new Map((meta || []).map((m: any) => [m.name, m]));
      const { data: ev } = await admin.from("platform_key_events").select("key_name, action, ok, detail, actor_email, at").order("at", { ascending: false }).limit(500);
      const lastOf = (name: string, act: string) => (ev || []).find((e: any) => e.key_name === name && e.action === act) || null;
      const keys = REGISTRY.map((k) => {
        const v: any = vault.get(k.name);
        const source = v ? "console" : Deno.env.get(k.name) ? "secret" : "missing";
        const set = lastOf(k.name, "set");
        const test = lastOf(k.name, "tested");
        return { ...k, source, updated_at: v?.updated_at || null, updated_by: set?.actor_email || null,
          last_test: test ? { ok: test.ok, detail: test.detail, at: test.at } : null };
      });
      return json({ ok: true, keys });
    }

    const name = String(body.name || "");
    const def = BY_NAME.get(name);
    if (!def) return json({ error: "unknown key" }, 400);

    if (action === "set") {
      let value = String(body.value ?? "").trim();
      if (!value) return json({ error: "enter the new key" }, 400);
      if (value.length > 20000) return json({ error: "that value is too long" }, 400);
      if (def.kind === "json") {
        try { const j = JSON.parse(value); if (!j.client_email || !j.private_key) throw new Error("missing fields"); value = JSON.stringify(j); }
        catch { return json({ error: "paste the whole service-account JSON file (it must include client_email and private_key)" }, 400); }
      }
      const { error } = await admin.rpc("platform_key_set", { p_name: name, p_value: value });
      if (error) return json({ error: `could not store the key: ${error.message}` }, 500);
      await log(name, "set", true, null);
      const t = await testKey(def, value, admin).catch((e) => ({ ok: false, detail: String(e?.message || e).slice(0, 200) }));
      await log(name, "tested", t.ok, t.detail);
      return json({ ok: true, test: t });
    }
    if (action === "clear") {
      const { error } = await admin.rpc("platform_key_set", { p_name: name, p_value: "" });
      if (error) return json({ error: `could not remove the key: ${error.message}` }, 500);
      await log(name, "cleared", true, null);
      return json({ ok: true, falls_back_to_secret: !!Deno.env.get(name) });
    }
    if (action === "test") {
      const value = await effectiveKey(admin, name);
      const t = value ? await testKey(def, value, admin).catch((e) => ({ ok: false, detail: String(e?.message || e).slice(0, 200) })) : { ok: false, detail: "No key is set." };
      await log(name, "tested", t.ok, t.detail);
      return json({ ok: true, test: t });
    }
    return json({ error: `unknown action "${action}"` }, 400);
  } catch (e) {
    console.error("platform-keys", e);
    return json({ error: "platform-keys error" }, 500);
  }
});
