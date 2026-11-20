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
    const { client_id, action = "pull", account, report_month } = await req.json().catch(() => ({}));
    if (!client_id) return json({ error: "client_id is required" }, 400);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Require an authenticated staff account before service-role reads.
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    // pg_cron may use a rotated legacy service JWT held in Vault, while the
    // Edge runtime exposes a newer service key. The Edge gateway verifies
    // JWT signatures (verify_jwt=true) before this code can execute.
    // Trust only a gateway-verified JWT whose signed role is service_role.
    let gatewayServiceRole=false;
    try{
      const segment=jwt.split(".")[1]||"";
      const claims=JSON.parse(atob(segment.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(segment.length/4)*4,"=")));
      gatewayServiceRole=claims.role==="service_role" && (typeof claims.exp!=="number" || claims.exp*1000>Date.now());
    }catch{/* no JWT claim */}
    const schedulerAuthorized = Boolean(jwt && ((svcKey && jwt === svcKey) || gatewayServiceRole));
    if (!schedulerAuthorized) {
      const { data: caller, error: authError } = await supa.auth.getUser(jwt);
      if (authError || !caller?.user) return json({ error: "Sign in required" }, 401);
      const { data: profile } = await supa.from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
      if (!profile) return json({ error: "Staff access required" }, 403);
      if (action === "backfill-month" && !["super_admin","admin"].includes(String(profile.role))) return json({error:"Admin access required for historical backfill"},403);
    }

    const { data: client, error: cErr } = await supa.from("clients")
      .select("id, url, intake, gsc_account_override, partner_groups(gsc_account)").eq("id", client_id).single();
    if (cErr || !client) return json({ error: "client not found", detail: cErr?.message }, 404);
    // The GSC credential is fixed by partner group, not by individual client.
    // Keep the legacy write action as an explicit rejection so old clients
    // cannot override this rule.
    if (action === "set-account") return json({ error: "GSC account is fixed by partner group and cannot be overridden" }, 403);
    if (action !== "pull" && action !== "backfill-month") return json({ error: "Unknown action" }, 400);
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
    const delegatedUser = acct === "44i" ? "media@44interactive.com" : undefined;
    const oauthRefresh = await platformKey("GSC_REFRESH_" + acct.toUpperCase());
    let authSource = "service_account";
    let serviceAccountEmail: string | null = null;
    let token: string;
    if (oauthRefresh) {
      // OAuth is selected only after a Super Admin connects the exact
      // partner-group Google account. An invalid grant fails explicitly;
      // never silently fall back to a different identity.
      const [id, secret] = await Promise.all([
        platformKey("GSC_OAUTH_CLIENT_ID"), platformKey("GSC_OAUTH_CLIENT_SECRET"),
      ]);
      if (!id || !secret) return json({error:"GSC OAuth credentials missing. Add the Google OAuth client ID and secret in Team & access."},500);
      const r = await fetch(TOKEN_URL,{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({
          grant_type:"refresh_token",client_id:id,client_secret:secret,refresh_token:oauthRefresh,
        }),signal:AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(()=>({}));
      if(!r.ok||!j.access_token)return json({
        error:"GSC OAuth refresh failed",
        message:"Reconnect the "+(acct==="44i"?"44i":"YourDigitalGroup")+" Google account in Team & access.",
        detail:String(j.error||r.status),
      },401);
      token=j.access_token;
      authSource="oauth";
    } else {
      // Legacy service-account access remains available until an OAuth
      // connection is authorized. No behavior changes for other groups.
      const saRaw=await platformKey(secretName);
      if (!saRaw) return json({error:`${secretName} is not set (group account tag: "${acct}")`},500);
      let sa:any;
      try {sa=JSON.parse(saRaw);}catch{return json({error:`${secretName} is not valid JSON`},500);}
      if(!sa.client_email||!sa.private_key)return json({error:"Service account JSON missing email/private_key"},500);
      serviceAccountEmail=sa.client_email;
      token=await getAccessToken(sa,delegatedUser);
    }
    const authH = { Authorization: `Bearer ${token}` };

    // Find the matching Search Console property
    const sitesRes = await fetch(`${WMT}/sites`, { headers: authH });
    const sitesJson = await sitesRes.json();
    if (!sitesRes.ok) return json({ error: "could not list GSC sites", detail: sitesJson }, 502);
    const sites = (sitesJson.siteEntry ?? []).map((s: any) => s.siteUrl as string);
    // Property identity must match the configured client host exactly.
    // Never use a substring match: example.com must not match notexample.com,
    // nor should a parent-domain property be mistaken for a subdomain site.
    const matchHost = (u: string) => {
      try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); }
      catch { return ""; }
    };
    const exactUrlSites = sites.filter((u: string) => /^https?:\/\//.test(u) && matchHost(u)===domain.toLowerCase());
    const canonicalUrl = /^https?:\/\//.test(String(client.url||""))
       ? new URL(String(client.url)).protocol : "https:";
    const preferredUrl = exactUrlSites.find((u:string)=>new URL(u).protocol===canonicalUrl);
    const exactDomain = sites.find((u:string)=>u.toLowerCase()===("sc-domain:"+domain.toLowerCase()));
    const match = preferredUrl ?? exactDomain ?? exactUrlSites[0];
    if (!match) {
      return json({
        error: "service_account_not_added",
        message: authSource === "oauth"
          ? `The connected Google account cannot see a Search Console property for ${domain}. Check that it is listed under the intended account in Google Search Console and retry.`
          : delegatedUser
            ? `The delegated Workspace user (${delegatedUser}) cannot see a matching Search Console property for ${domain}. Confirm that user has access.`
            : `The service account (${serviceAccountEmail}) does not yet have access to ${domain}. Connect Google OAuth in Team & access instead of adding users separately.`,
        auth_source: authSource,
        service_account: serviceAccountEmail,
        domain,
        properties_visible: sites,
      }, 403);
    }


    // Explicitly backfill a past report month from Google's actual historical
    // Search Analytics, not from the newest snapshot. Uses 90 complete days
    // ending on the selected month-end to match the scorecard's 90D label.
    if(action==="backfill-month"){
      const target=String(report_month||"");
      if(!/^20[0-9]{2}-(0[1-9]|1[0-2])-01$/.test(target))
        return json({error:"report_month must be YYYY-MM-01"},400);
      const targetDate=new Date(target+"T00:00:00Z");
      const endDate=new Date(Date.UTC(targetDate.getUTCFullYear(),targetDate.getUTCMonth()+1,0));
      if(endDate.getTime()>=Date.now())return json({error:"Only completed months may be backfilled"},400);
      if(endDate.getTime()<Date.now()-16*31*86400000)
        return json({error:"Selected month is outside the supported historical window"},400);
      const last=endDate.toISOString().slice(0,10);
      const first=new Date(endDate.getTime()-89*86400000).toISOString().slice(0,10);
      const historicalRes=await fetch(`${WMT}/sites/${encodeURIComponent(match)}/searchAnalytics/query`,{
        method:"POST",headers:{...authH,"Content-Type":"application/json"},
        body:JSON.stringify({startDate:first,endDate:last,dimensions:["query"],rowLimit:25}),
        signal:AbortSignal.timeout(25000),
      });
      const historicalJson=await historicalRes.json().catch(()=>({}));
      if(!historicalRes.ok)return json({error:"Google rejected historical Search Analytics query",detail:historicalJson,status:historicalRes.status},502);
      const historicalRows=(historicalJson.rows||[]).filter((r:any)=>String(r.keys?.[0]||"").length>0);
      // A genuine empty response must not overwrite metrics with a false zero.
      if(!historicalRows.length)return json({error:"Google returned no historical query rows for this period. Existing reporting data was not changed.",property:match,period_start:first,period_end:last},422);
      const historyTotals=historicalRows.reduce((a:any,r:any)=>({impressions:a.impressions+Number(r.impressions||0),clicks:a.clicks+Number(r.clicks||0)}),{impressions:0,clicks:0});
      const {error:saveHistoricalErr}=await supa.from("gsc_monthly_90d_metrics").upsert({
        client_id:client.id,report_month:target,query_surface:historicalRows.length,
        impressions_90d:historyTotals.impressions,clicks_90d:historyTotals.clicks,
        period_start:first,period_end:last,property_url:match,
        source:"gsc_searchanalytics_top_25_queries",pulled_at:new Date().toISOString(),
      },{onConflict:"client_id,report_month"});
      if(saveHistoricalErr)throw saveHistoricalErr;
      return json({ok:true,mode:"historical_90d",account:acct,auth_source:authSource,
        property:match,report_month:target,period_start:first,period_end:last,
        query_count:historicalRows.length,totals:historyTotals,
        note:"Top 25 GSC search queries for the completed 90-day period, not full-property totals."});
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

    // Cross-check with Google property-wide totals, never infer full traffic
    // by summing top query rows. A dimension-free query returns one aggregate
    // row and avoids query-level anonymization/truncation.
    const totalRes=await fetch(`${WMT}/sites/${encodeURIComponent(match)}/searchAnalytics/query`,{
      method:"POST",headers:{...authH,"Content-Type":"application/json"},
      body:JSON.stringify({startDate:start,endDate:end,type:"web",aggregationType:"byProperty",dataState:"final"}),
      signal:AbortSignal.timeout(25000),
    });
    const totalJson=await totalRes.json().catch(()=>({}));
    if(!totalRes.ok)return json({error:"GSC property-total verification failed",detail:totalJson},502);
    const propertyRows=Array.isArray(totalJson.rows)?totalJson.rows:[];
    const totalRow=propertyRows.length===1?propertyRows[0]:null;
    if(propertyRows.length>1)return json({error:"GSC returned multiple property-total rows; refusing ambiguous totals"},422);
    const fullImpressions=totalRow?Number(totalRow.impressions):null;
    const fullClicks=totalRow?Number(totalRow.clicks):null;
    const sampleTotals=rows.reduce((sum,r)=>({
      clicks:sum.clicks+r.clicks,impressions:sum.impressions+r.impressions
    }),{clicks:0,impressions:0});
    if(fullImpressions!==null &&
      (!Number.isSafeInteger(fullImpressions)||!Number.isSafeInteger(fullClicks)||
       fullImpressions<0||fullClicks<0||
       sampleTotals.impressions>fullImpressions||sampleTotals.clicks>fullClicks)){
      return json({error:"GSC query sample exceeds property totals or property totals are invalid; refusing to save",
        sample:sampleTotals, property:{impressions:fullImpressions,clicks:fullClicks}},422);
    }
    // Empty GSC responses are not proof of zero traffic; mark unverified.
    const validated=fullImpressions!==null && fullClicks!==null && rows.length>0;

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


    // Search specific targeted landing pages in GSC, independently from
    // the general top-page query, then verify the returned canonical URL.
    const targetText = String((client as any).intake?.landing_targets || "");
    const targets = Array.from(new Set(targetText.split(String.fromCharCode(10)).map((entry: string) => {
      const item = entry.trim(); if(!item)return "";
      let slug: string;
      if(item.startsWith("https://") || item.startsWith("http://")){
        try {
          const u = new URL(item);
          const expected = new URL(client.url.startsWith("http")?client.url:"https://"+client.url);
          if(u.hostname.replace("www.","") !== expected.hostname.replace("www.",""))return "";
          slug=u.pathname;
        }catch{return "";}
      }else if(item.startsWith("/"))slug=item.split("?")[0].split("#")[0];
      else slug="/"+item.toLowerCase().replace(new RegExp("[^a-z0-9]+","g"),"-").replace(new RegExp("^-|-$","g"),"")+"/";
      return "/"+slug.split("/").filter(Boolean).join("/")+"/";
    }).filter((x: string)=>x && x!=="/"))).slice(0,40);
    const normalize = (value: string) => {
      try {
        const u = new URL(value);
        return u.hostname.toLowerCase().replace("www.","")+"/"+u.pathname.split("/").filter(Boolean).join("/").toLowerCase();
      } catch {return "";}
    };
    const origin = new URL(client.url.startsWith("http")?client.url:"https://"+client.url);
    const siteHost=origin.hostname.toLowerCase().replace("www.","");
    const directPages: any[]=[];
    const targetLookupWarnings: string[]=[];

    const previousEnd = new Date(new Date(monthStart+"T00:00:00Z").getTime()-86400000).toISOString().slice(0,10);
    const previousStart = new Date(new Date(previousEnd+"T00:00:00Z").getTime()-89*86400000).toISOString().slice(0,10);
    const periods=[
      {report_month:monthStart,start,end},
      {report_month:previousEnd.slice(0,7)+"-01",start:previousStart,end:previousEnd}
    ];
    for(const period of periods) {
      for(const slug of targets){
        const response=await fetch(`${WMT}/sites/${encodeURIComponent(match)}/searchAnalytics/query`,{
          method:"POST",headers:{...authH,"Content-Type":"application/json"},
          body:JSON.stringify({
            startDate:period.start,endDate:period.end,dimensions:["page"],rowLimit:250,
            dimensionFilterGroups:[{filters:[{dimension:"page",operator:"contains",expression:slug.slice(0,-1)}]}]
          })
        });
        const payload=await response.json();
        if(!response.ok){targetLookupWarnings.push(period.report_month+":"+slug+" ("+response.status+")");continue;}
        const expected=siteHost+slug.slice(0,-1).toLowerCase();
        const found=(payload.rows||[]).filter((r:any)=>r.keys?.[0]&&normalize(r.keys[0])===expected);
        const totals=found.reduce((a:any,r:any)=>({clicks:a.clicks+Number(r.clicks||0),impressions:a.impressions+Number(r.impressions||0)}),{clicks:0,impressions:0});
        directPages.push({client_id:client.id,report_month:period.report_month,target_slug:slug,
          matched_page_url:found[0]?.keys?.[0]||null,
          impressions:found.length?totals.impressions:null,clicks:found.length?totals.clicks:null,
          period_start:period.start,period_end:period.end,lookup_status:found.length?"matched":"not_returned"});
      }
    }
    if(directPages.length){
      const {error:saveTargetError}=await supa.from("gsc_targeted_pages_90d")
        .upsert(directPages,{onConflict:"client_id,report_month,target_slug"});
      if(saveTargetError)throw saveTargetError;
    }
    for(const period of periods){
      const {data:existingTargets,error:targetReadError}=await supa.from("gsc_targeted_pages_90d")
        .select("target_slug").eq("client_id",client.id).eq("report_month",period.report_month);
      if(targetReadError)throw targetReadError;
      for(const record of existingTargets||[]){
        if(!targets.includes(record.target_slug)){
          const {error:removeError}=await supa.from("gsc_targeted_pages_90d").delete()
            .eq("client_id",client.id).eq("report_month",period.report_month).eq("target_slug",record.target_slug);
          if(removeError)throw removeError;
        }
      }
    }

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
    // Success is recorded only after the collection and storage steps complete.
    // The signed-in user's "connected" toggle is not a measure of freshness.
    const checkedAt=new Date().toISOString();
    const {error:healthErr}=await supa.from("gsc_pull_health").upsert({
      client_id:client.id,last_attempt_at:checkedAt,
      last_success_at:validated?checkedAt:null,
      last_status:validated?"success":"unverified",
      error_code:validated?null:"empty_gsc_property_or_query_rows",
      property_url:match,credential_type:authSource,
      period_start:start,period_end:end,query_count:rows.length,
      sample_impressions:sampleTotals.impressions,sample_clicks:sampleTotals.clicks,
      property_impressions:fullImpressions,property_clicks:fullClicks,
      validation_note:validated
        ? "Google finalized property totals verified independently of top 25 query sample"
        : "Google returned an empty aggregate or query list; do not treat as zero traffic",
    },{onConflict:"client_id"});
    if(healthErr)throw healthErr;
    const {error:clientMarkErr}=await supa.from("clients").update({gsc_connected:true}).eq("id",client.id);
    if(clientMarkErr)throw clientMarkErr;
    return json({ ok:true, quality_status:validated?"verified_recent":"needs_review",
      account:acct,auth_source:authSource,service_account:serviceAccountEmail,
      delegated_user:authSource==="service_account"?delegatedUser||null:null,
      property:match,query_count:rows.length,totals:sampleTotals,
      property_totals:{impressions:fullImpressions,clicks:fullClicks},
      period_start:start,period_end:end,
      top:rows.slice(0,5),pages_count:pageRows.length,
      page_impressions:pageRows.reduce((n:number,r:any)=>n+r.impressions,0),
      pages_90d_count:page90Rows.length,targeted_pages_checked:directPages.length,
      targeted_pages_found:directPages.filter(x=>x.lookup_status==="matched").length,
      targeted_lookup_warnings:targetLookupWarnings });
  } catch (e) {
    console.error("pull-gsc fatal", e);
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
});