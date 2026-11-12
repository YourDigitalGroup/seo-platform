// ============================================================================
//  wp-events — the WordPress connector telling the platform something happened
//  on a client site. Today: a scheduled piece the platform sent went LIVE.
// ----------------------------------------------------------------------------
//  The connector (1.12+) schedules approved content as WordPress "future"
//  posts; WordPress's own cron publishes them. On that transition the plugin
//  POSTs here, and we:
//    1. record it once (wp_publish_events, unique per client + piece),
//    2. mark the campaign deliverable delivered, with the live URL,
//    3. comment on the client's Trello card tagging the ACCOUNT MANAGER on
//       the account (partner_groups.am_email → profiles.trello_username),
//       adding them to the card first so the @mention actually notifies.
//
//  Auth: the site's connector API key (Authorization: Bearer <key>) must match
//  clients.wp_api_key — the same gate as wp-ai. Deploy with verify_jwt OFF:
//  WordPress can't send a Supabase JWT; the site key is the gate.
//
//  Input:  { event: "published", external_id, title, url, published_at,
//            post_type?, post_id?, site?, plugin_version? }
//  Output: { ok: true, trello: "posted" | "no_card" | "…" } | { error }
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

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hostOf = (u: string) => { try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const siteKey = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[A-Za-z0-9]{24,128}$/.test(siteKey)) return json({ error: "missing or malformed site key" }, 401);
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: rows } = await supa.from("clients")
    .select("id, name, url, partner_group_id, trello_card_id").eq("wp_api_key", siteKey).limit(2);
  const client = (rows || [])[0];
  if (!client) return json({ error: "this site isn't connected to the SEO Platform" }, 401);

  const body = await req.json().catch(() => ({}));
  if (String(body.event || "") !== "published") return json({ error: "unsupported event" }, 400);
  const external = String(body.external_id || "").trim().slice(0, 64);
  if (!external) return json({ error: "external_id required" }, 400);
  const title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 300) || "Untitled";
  // Only a link on the client's own site goes into Trello / the deliverable.
  let url = String(body.url || "").trim().slice(0, 1000);
  if (!/^https?:\/\//i.test(url) || hostOf(url) !== hostOf(String(client.url || ""))) url = "";
  const at = new Date(String(body.published_at || ""));
  const publishedAt = isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();

  // The piece: external_id is the content topic id the deploy file used.
  // Trust it only when that topic belongs to this client.
  let topicId: string | null = null, kind = "";
  if (UUID.test(external)) {
    const { data: t } = await supa.from("content_topics").select("id, kind, packages!inner(client_id)").eq("id", external).maybeSingle();
    const owner: any = t && (Array.isArray((t as any).packages) ? (t as any).packages[0] : (t as any).packages);
    if (t && owner?.client_id === client.id) { topicId = t.id; kind = String(t.kind || ""); }
  }

  // Once per piece: a republish (unpublish → publish) doesn't ping again.
  const { data: ev, error: evErr } = await supa.from("wp_publish_events").insert({
    client_id: client.id, external_id: external, topic_id: topicId, title, url: url || null,
    published_at: publishedAt, post_type: String(body.post_type || "").slice(0, 20) || null,
    plugin_version: String(body.plugin_version || "").slice(0, 20) || null,
  }).select("id").maybeSingle();
  if (evErr) {
    if (/duplicate key|unique/i.test(evErr.message || "")) return json({ ok: true, duplicate: true });
    console.error("wp-events insert", evErr);
    return json({ error: "could not record the event" }, 500);
  }

  if (topicId) {
    await supa.from("deliverables").update({ state: "delivered", ...(url ? { asset_url: url } : {}) })
      .eq("client_id", client.id).eq("topic_id", topicId);
  }

  // ── Trello: tag the account manager on the client's card ──
  const finish = async (status: string, detail = "") => {
    await supa.from("wp_publish_events").update({ trello_status: status, trello_detail: detail.slice(0, 400) || null }).eq("id", ev!.id);
    return json({ ok: true, trello: status, ...(detail ? { detail } : {}) });
  };
  const cardId = String(client.trello_card_id || "").trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(cardId)) return finish("no_card", "client has no Trello card — submit it to a specialist first");
  const KEY = await platformKey("TRELLO_KEY"), TOKEN = await platformKey("TRELLO_TOKEN");
  if (!KEY || !TOKEN) return finish("not_configured", "TRELLO_KEY / TRELLO_TOKEN not set");
  const auth = `key=${KEY}&token=${TOKEN}`;
  const trello = async (method: string, path: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`https://api.trello.com/1${path}?${auth}${qs ? "&" + qs : ""}`, { method, signal: AbortSignal.timeout(15_000) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Trello ${method} ${path.replace(/\/[A-Za-z0-9]{6,32}(\/|$)/, "/…$1")} → HTTP ${r.status}: ${txt.slice(0, 160)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  };

  let amName = "", amEmail = "", handle = "";
  if (client.partner_group_id) {
    const { data: g } = await supa.from("partner_groups").select("am_name, am_email").eq("id", client.partner_group_id).maybeSingle();
    amName = String(g?.am_name || ""); amEmail = String(g?.am_email || "").trim();
  }
  if (amEmail) {
    const { data: p } = await supa.from("profiles").select("name, trello_username").ilike("email", amEmail).maybeSingle();
    handle = String(p?.trello_username || "").replace(/^@/, "").trim();
    amName = amName || String(p?.name || "");
  }
  const warnings: string[] = [];
  if (handle) {
    // An @mention only notifies people on the card — add the AM first.
    try {
      const m = await trello("GET", `/members/${encodeURIComponent(handle)}`, { fields: "id" });
      if (m?.id) await trello("POST", `/cards/${cardId}/idMembers`, { value: m.id }).catch(() => { /* already on the card */ });
    } catch { warnings.push(`Trello user @${handle} not found`); }
  } else {
    warnings.push(amName ? `no Trello @username on ${amName}'s profile (Team & access)` : "no account manager on this partner group");
  }

  const what = kind === "landing" || kind === "service" ? "page" : kind === "pillar" ? "pillar page" : kind === "blog" ? "blog post" : "post";
  const who = handle ? `@${handle}` : (amName ? `${amName}:` : "");
  const text = `${who} The scheduled ${what} for ${client.name || client.url} is now live: “${title}”${url ? `\n${url}` : ""}`.trim();
  try {
    await trello("POST", `/cards/${cardId}/actions/comments`, { text: text.slice(0, 1000) });
  } catch (e) {
    return finish("failed", String((e as any)?.message || e).replace(/\b(key|token)=[^&\s"']+/gi, "$1=***"));
  }
  return finish(handle && !warnings.length ? "posted" : "posted_untagged", warnings.join("; "));
});
