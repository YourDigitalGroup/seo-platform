// ============================================================================
//  wp-ai — the WordPress connector's AI proxy.
// ----------------------------------------------------------------------------
//  The connector plugin's AI auto-fix (alt text, SEO titles/descriptions,
//  internal links, About copy) used to call Anthropic directly with a key
//  baked into every zip or typed in per site — readable by any admin of any
//  client site. Now the key lives only here (ANTHROPIC_API_KEY, optional
//  ANTHROPIC_WORKSPACE_ID — the same secrets the other AI functions use) and
//  the plugin calls this function instead.
//
//  Auth: the site's own connector API key (Authorization: Bearer <key>) — the
//  key the team already pastes into the client's Platform Access. It must
//  match clients.wp_api_key of an active client. Deploy with verify_jwt OFF:
//  WordPress can't send a Supabase JWT; the site key is the gate.
//
//  Guard rails: fixed model (Haiku), max_tokens capped, prompt sizes capped,
//  DAILY_CAP calls per site per day (wp_ai_usage, wp_ai_usage.sql).
//
//  Input:  { system: string, user: string, max_tokens?: number }
//  Output: { ok: true, text, stop_reason }  |  { error }
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

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1200;
const DAILY_CAP = 400;   // one weekly auto-fix run is ~30-60 calls

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const siteKey = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!/^[A-Za-z0-9]{24,128}$/.test(siteKey)) return json({ error: "missing or malformed site key" }, 401);

    const AI_KEY = (await platformKey("ANTHROPIC_API_KEY"));
    if (!AI_KEY) return json({ error: "the platform's AI key is not configured" }, 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: rows } = await supa.from("clients").select("id, url, status").eq("wp_api_key", siteKey).limit(2);
    const client = (rows || [])[0];
    if (!client) return json({ error: "this site isn't connected to the SEO Platform — paste its connector API key into the client's Platform Access" }, 401);
    if (client.status !== "active") return json({ error: "this client's campaign is suspended on the SEO Platform" }, 403);

    const body = await req.json().catch(() => ({}));
    const system = String(body.system || "").slice(0, 6000);
    const user = String(body.user || "");
    if (!user.trim()) return json({ error: "user prompt required" }, 400);
    if (user.length > 30000) return json({ error: "prompt too long" }, 400);
    const maxTokens = Math.min(Math.max(16, Number(body.max_tokens) || 600), MAX_TOKENS);

    const { data: today } = await supa.from("wp_ai_usage").select("calls")
      .eq("client_id", client.id).eq("day", new Date().toISOString().slice(0, 10)).maybeSingle();
    if ((today?.calls || 0) >= DAILY_CAP) return json({ error: `daily AI limit reached for this site (${DAILY_CAP} calls) — it resets tomorrow` }, 429);

    const wsid = (await platformKey("ANTHROPIC_WORKSPACE_ID")) || "";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json",
        ...(wsid ? { "anthropic-workspace-id": wsid } : {}) },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, ...(system ? { system } : {}),
        messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error(`wp-ai ${client.url}: anthropic ${r.status} ${txt.slice(0, 200)}`);
      return json({ error: `AI service error ${r.status}` }, 502);
    }
    const data = JSON.parse(txt);
    const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    await supa.rpc("wp_ai_record", { p_client: client.id, p_in: data.usage?.input_tokens ?? 0, p_out: data.usage?.output_tokens ?? 0 });
    return json({ ok: true, text, stop_reason: data.stop_reason ?? null });
  } catch (e) {
    console.error("wp-ai fatal", e);
    return json({ error: "AI proxy error" }, 500);
  }
});
