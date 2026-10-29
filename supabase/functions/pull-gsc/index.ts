// ============================================================================
//  44i SEO/AEO Delivery System — pull-gsc Edge Function
//  Pulls real Google Search Console data for a client using a service account
//  (no OAuth flow). Authenticates by signing a JWT with the service account
//  private key and exchanging it for an access token.
//  Deploy in: Supabase Dashboard → Edge Functions → Deploy a new function
//  Name the function exactly:  pull-gsc
//  Required secret (already set):  GSC_SERVICE_ACCOUNT  (the full service-account JSON)
//  Prereq: the service account email must be added as a user on the client's
//          Search Console property.
//  Input:  { "client_id": "<uuid>" }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const WMT = "https://www.googleapis.com/webmasters/v3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// base64url for strings and byte arrays
function b64url(input: string | Uint8Array): string {
  const bin = typeof input === "string" ? input : Array.from(input).map((c) => String.fromCharCode(c)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
// Sign a Google service-account JWT and exchange it for an access token
async function getAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const assertion = `${unsigned}.${b64url(sig)}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("token exchange failed: " + JSON.stringify(j));
  return j.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { client_id, action = "pull", account } = await req.json().catch(() => ({}));
    if (!client_id) return json({ error: "client_id is required" }, 400);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Require an authenticated staff account before service-role reads.
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller, error: authError } = await supa.auth.getUser(jwt);
    if (authError || !caller?.user) return json({ error: "Sign in required" }, 401);
    const { data: profile } = await supa.from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
    if (!profile) return json({ error: "Staff access required" }, 403);

    const { data: client, error: cErr } = await supa.from("clients")
      .select("id, url, gsc_account_override, partner_groups(gsc_account)").eq("id", client_id).single();
    if (cErr || !client) return json({ error: "client not found", detail: cErr?.message }, 404);
    // The GSC credential is fixed by partner group, not by individual client.
    // Keep the legacy write action as an explicit rejection so old clients
    // cannot override this rule.
    if (action === "set-account") return json({ error: "GSC account is fixed by partner group and cannot be overridden" }, 403);
    if (action !== "pull") return json({ error: "Unknown action" }, 400);
    const domain = String(client.url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!domain) return json({ error: "client has no URL" }, 400);

    // Map the group's account tag -> the secret holding that service account JSON.
    // Add a new account later by adding one entry here + a matching Supabase secret.
    const SA_SECRET: Record<string, string> = {
      "default": "GSC_SERVICE_ACCOUNT",       // general account — serves all groups
      "44i":     "GSC_SERVICE_ACCOUNT_44I",   // 44i Digital's own account
    };
    const acct = (client as any).partner_groups?.gsc_account === "44i" ? "44i" : "default";
    const secretName = SA_SECRET[acct] || "GSC_SERVICE_ACCOUNT";
    const saRaw = Deno.env.get(secretName);
    if (!saRaw) return json({ error: `${secretName} is not set (group account tag: "${acct}")` }, 500);
    let sa: any;
    try { sa = JSON.parse(saRaw); } catch { return json({ error: `${secretName} is not valid JSON` }, 500); }
    if (!sa.client_email || !sa.private_key) return json({ error: "service account JSON missing client_email/private_key" }, 500);

    // Authenticate as the service account
    const token = await getAccessToken(sa);
    const authH = { Authorization: `Bearer ${token}` };

    // Find the matching Search Console property
    const sitesRes = await fetch(`${WMT}/sites`, { headers: authH });
    const sitesJson = await sitesRes.json();
    if (!sitesRes.ok) return json({ error: "could not list GSC sites", detail: sitesJson }, 502);
    const sites = (sitesJson.siteEntry ?? []).map((s: any) => s.siteUrl as string);
    const match = sites.find((u) => u.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "") === domain)
      ?? sites.find((u) => u.includes(domain));
    if (!match) {
      return json({
        error: "service_account_not_added",
        message: `The service account (${sa.client_email}) does not yet have access to a Search Console property for ${domain}. Add it as a user in that property's Settings → Users and permissions, then retry.`,
        properties_visible: sites,
      }, 403);
    }

    // Query the last 90 days of top queries
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const qRes = await fetch(`${WMT}/sites/${encodeURIComponent(match)}/searchAnalytics/query`, {
      method: "POST", headers: { ...authH, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: start, endDate: end, dimensions: ["query"], rowLimit: 25 }),
    });
    const qJson = await qRes.json();
    if (!qRes.ok) return json({ error: "search analytics query failed", detail: qJson }, 502);
    const rows = (qJson.rows ?? []).map((r: any) => ({
      query: r.keys?.[0] ?? "", clicks: r.clicks ?? 0, impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0, position: r.position ?? 0,
    }));

    // Store a fresh snapshot
    await supa.from("gsc_queries").delete().eq("client_id", client.id);
    if (rows.length) {
      await supa.from("gsc_queries").insert(rows.map((r) => ({ client_id: client.id, ...r })));
    }
    // Mark GSC connected
    await supa.from("clients").update({ gsc_connected: true }).eq("id", client.id);

    const totals = rows.reduce((a, r) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }), { clicks: 0, impressions: 0 });
    return json({ ok: true, account: acct, service_account: sa.client_email, property: match, query_count: rows.length, totals, top: rows.slice(0, 5) });
  } catch (e) {
    console.error("pull-gsc fatal", e);
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
});