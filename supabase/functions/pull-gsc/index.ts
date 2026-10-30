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
async function getAccessToken(sa: { client_email: string; private_key: string }, delegatedUser?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
    ...(delegatedUser ? { sub: delegatedUser } : {}),
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
  if (!res.ok) {
    const reason = String(j?.error || "unknown");
    const detail = String(j?.error_description || "");
    throw new Error(`Google token exchange failed (${reason}): ${detail}. ${delegatedUser ? "Verify the exact service account client ID was authorized for domain-wide delegation in Google Workspace, the Search Console read-only scope was granted, and the delegated user exists: " + delegatedUser : "Check service account credentials."}`);
  }
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
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const schedulerAuthorized = Boolean(svcKey && jwt === svcKey);
    if (!schedulerAuthorized) {
      const { data: caller, error: authError } = await supa.auth.getUser(jwt);
      if (authError || !caller?.user) return json({ error: "Sign in required" }, 401);
      const { data: profile } = await supa.from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
      if (!profile) return json({ error: "Staff access required" }, 403);
    }

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
    const saRaw = await platformKey(secretName);
    if (!saRaw) return json({ error: `${secretName} is not set (group account tag: "${acct}")` }, 500);
    let sa: any;
    try { sa = JSON.parse(saRaw); } catch { return json({ error: `${secretName} is not valid JSON` }, 500); }
    if (!sa.client_email || !sa.private_key) return json({ error: "service account JSON missing client_email/private_key" }, 500);

    // Only the 44i partner group uses Workspace domain-wide delegation.
    // All other groups keep their existing service-account authentication.
    const delegatedUser = acct === "44i" ? "media@44interactive.com" : undefined;
    // The Workspace admin must grant DWD to the numeric OAuth Client ID of
    // the service account stored in GSC_SERVICE_ACCOUNT_44I.
    // The Google mailbox itself is never used as a credential.
    const token = await getAccessToken(sa, delegatedUser);
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
        message: delegatedUser
          ? `The delegated Workspace user (${delegatedUser}) cannot see a matching Search Console property for ${domain}. Confirm the user has access to that property and the URL is correct.`
          : `The service account (${sa.client_email}) does not yet have access to a Search Console property for ${domain}. Add it as a user in that property's Settings → Users and permissions, then retry.`,
        service_account: sa.client_email,
        domain,
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

    // Pull page-level results for the current calendar month. Search Console
    // may finalize its most recent days with a delay; never invent missing data.
    const monthStart = end.slice(0, 7) + "-01";
    const pagesRes = await fetch(`${WMT}/sites/${encodeURIComponent(match)}/searchAnalytics/query`, {
      method: "POST", headers: { ...authH, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: monthStart, endDate: end,
        dimensions: ["page"], rowLimit: 1000 }),
    });
    const pagesJson = await pagesRes.json();
    if (!pagesRes.ok) return json({ error: "search analytics page query failed", detail: pagesJson }, 502);
    const pageRows = (pagesJson.rows ?? []).map((r: any) => ({
      client_id: client.id, page_url: r.keys?.[0] ?? "",
      clicks: r.clicks ?? 0, impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0, position: r.position ?? 0,
      period_start: monthStart, period_end: end,
    })).filter((r: any) => r.page_url);

    // Page-level 90-day impressions for targeted landing page reporting.
    const pages90Res = await fetch(`${WMT}/sites/${encodeURIComponent(match)}/searchAnalytics/query`, {
      method: "POST", headers: { ...authH, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: start, endDate: end,
        dimensions: ["page"], rowLimit: 25000 }),
    });
    const pages90Json = await pages90Res.json();
    if (!pages90Res.ok) return json({ error: "search analytics 90-day page query failed", detail: pages90Json }, 502);
    const page90Rows = (pages90Json.rows ?? []).map((r: any) => ({
      client_id: client.id, page_url: r.keys?.[0] ?? "",
      clicks: r.clicks ?? 0, impressions: r.impressions ?? 0,
      period_start: start, period_end: end,
    })).filter((r: any) => r.page_url);

    // Store a fresh snapshot
    await supa.from("gsc_queries").delete().eq("client_id", client.id);
    if (rows.length) {
      await supa.from("gsc_queries").insert(rows.map((r) => ({ client_id: client.id, ...r })));
    }
    // Keep prior months intact; refresh only the current month's page snapshot.
    const { error: pageDeleteErr } = await supa.from("gsc_pages").delete()
      .eq("client_id", client.id).gte("pulled_at", monthStart + "T00:00:00Z");
    if (pageDeleteErr) throw pageDeleteErr;
    if (pageRows.length) {
      const { error: pageInsertErr } = await supa.from("gsc_pages").insert(pageRows);
      if (pageInsertErr) throw pageInsertErr;
    }
    // Retain older monthly snapshots; replace this month's 90-day snapshot.
    const { error: delete90Err } = await supa.from("gsc_pages_90d").delete()
      .eq("client_id", client.id).gte("pulled_at", monthStart + "T00:00:00Z");
    if (delete90Err) throw delete90Err;
    for (let i = 0; i < page90Rows.length; i += 500) {
      const { error: insert90Err } = await supa.from("gsc_pages_90d")
        .insert(page90Rows.slice(i, i + 500));
      if (insert90Err) throw insert90Err;
    }
    // Mark GSC connected
    await supa.from("clients").update({ gsc_connected: true }).eq("id", client.id);

    const totals = rows.reduce((a, r) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }), { clicks: 0, impressions: 0 });
    return json({ ok: true, account: acct, service_account: sa.client_email, delegated_user: delegatedUser || null, property: match, query_count: rows.length, totals, top: rows.slice(0, 5), pages_count: pageRows.length, page_impressions: pageRows.reduce((n: number,r: any) => n + r.impressions,0), pages_90d_count: page90Rows.length });
  } catch (e) {
    console.error("pull-gsc fatal", e);
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
});