// ============================================================================
//  gbp-callback: where Google sends a Super Admin back after they sign in to
//  connect a Business Profile account (Team & access → Google Business
//  Profile). This URL is the OAuth client's Authorized redirect URI:
//    https://<project>.supabase.co/functions/v1/gbp-callback
//  Deployed with JWT verification OFF (Google can't send a Supabase JWT); the
//  one-time `state` created by gbp → connect is the gate. Exchanges the code
//  for a refresh token, keeps it in Vault (platform key GBP_REFRESH_<KEY>),
//  and sends the browser back to the console page that started the sign-in.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

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

// Supabase serves function responses as plain text, so results go back to
// the console as a redirect with ?gbp=connected|error&gbp_msg=…
const back = (returnTo: string | null, params: Record<string, string>) => {
  if (!returnTo) return new Response(`${params.gbp === "connected" ? "Connected" : "Not connected"}: ${params.gbp_msg || ""}\nYou can close this tab and refresh Team & access.`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const u = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "", gErr = url.searchParams.get("error") || "";
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  if (!/^[a-f0-9]{64}$/.test(state)) return new Response("Missing or invalid sign-in state.", { status: 400 });
  // One-time use: the state row is deleted as it's read.
  const { data: st } = await supa.from("gbp_oauth_states").delete().eq("state", state).select("connection, return_to, created_by, created_at").maybeSingle();
  if (!st || Date.now() - new Date(st.created_at).getTime() > 30 * 60_000) return new Response("This sign-in link expired. Start again from Team & access.", { status: 400 });
  const ret = st.return_to;
  if (gErr) return back(ret, { gbp: "error", gbp_conn: st.connection, gbp_msg: gErr === "access_denied" ? "Google sign-in was cancelled" : `Google: ${gErr}` });
  try {
    const [id, secret] = [await platformKey("GBP_OAUTH_CLIENT_ID"), await platformKey("GBP_OAUTH_CLIENT_SECRET")];
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, client_secret: secret,
        redirect_uri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/gbp-callback` }), signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google: ${j.error_description || j.error || r.status}`);
    if (!String(j.scope || "").includes("business.manage")) throw new Error("the Business Profile permission wasn't granted — tick it on Google's consent screen");
    if (!j.refresh_token) throw new Error("Google didn't return a refresh token — remove the app's access at myaccount.google.com/permissions and connect again");
    let email = "";
    try { const p = String(j.id_token || "").split(".")[1]; email = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(p.length / 4) * 4, "="))).email || ""; } catch { /* email is a nicety */ }
    const { error } = await supa.rpc("platform_key_set", { p_name: `GBP_REFRESH_${String(st.connection).toUpperCase()}`, p_value: j.refresh_token });
    if (error) throw new Error(`storing the sign-in: ${error.message}`);
    await supa.from("gbp_connections").update({ account_email: email || null, connected_at: new Date().toISOString(), connected_by: st.created_by, last_error: null }).eq("key", st.connection);
    await supa.from("platform_key_events").insert({ key_name: `GBP_REFRESH_${String(st.connection).toUpperCase()}`, action: "set", ok: true,
      detail: `Google Business Profile connected as ${email || "unknown account"}`, actor_email: st.created_by });
    return back(ret, { gbp: "connected", gbp_conn: st.connection, gbp_msg: email ? `Connected as ${email}` : "Connected" });
  } catch (e) {
    const msg = String((e as any)?.message || e).slice(0, 200);
    await supa.from("gbp_connections").update({ last_error: msg }).eq("key", st.connection);
    return back(ret, { gbp: "error", gbp_conn: st.connection, gbp_msg: msg });
  }
});
