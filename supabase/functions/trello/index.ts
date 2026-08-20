// ============================================================================
//  trello — the console's handoff to the delivery board.
// ----------------------------------------------------------------------------
//  Two jobs:
//   · submit  — "Submit to SEO/AEO specialist" on the Setup tab. Creates a
//               card on the web board in the strategist's list ("Sarah B.
//               SEO/AEO" / "Olivia SEO/AEO" — found by first name, created if
//               missing), due in 2 days, described with the kickoff summary.
//               The card id is remembered on the client.
//   · comment — posted when a strategist approves content, so the card
//               carries the approval trail.
//
//  Deploy: Edge Functions → trello.
//  Secrets: TRELLO_KEY, TRELLO_TOKEN (trello.com/power-ups/admin → API key +
//           token), TRELLO_BOARD_ID (the web board's id from its URL).
//  Input:  { action: "submit",  client_id, strategist_name, summary? }
//          { action: "comment", client_id, text }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const DUE_DAYS = 2;   // per policy: two days per package

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const KEY = Deno.env.get("TRELLO_KEY"), TOKEN = Deno.env.get("TRELLO_TOKEN");
    const BOARD = Deno.env.get("TRELLO_BOARD_ID");
    if (!KEY || !TOKEN || !BOARD) {
      return json({ error: "Trello not configured — set TRELLO_KEY, TRELLO_TOKEN and TRELLO_BOARD_ID under Edge Functions → trello → Secrets" }, 500);
    }
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // signed-in staff only
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await supa.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "sign in required" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (!body.client_id) return json({ error: "client_id required" }, 400);
    const { data: client } = await supa.from("clients").select("*").eq("id", body.client_id).maybeSingle();
    if (!client) return json({ error: "no such client" }, 404);

    const auth = `key=${KEY}&token=${TOKEN}`;
    const trello = async (method: string, path: string, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      const r = await fetch(`https://api.trello.com/1${path}?${auth}${qs ? "&" + qs : ""}`, { method });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Trello ${method} ${path} → HTTP ${r.status}: ${txt.slice(0, 200)}`);
      try { return JSON.parse(txt); } catch { return txt; }
    };

    if (action === "submit") {
      const strategist = String(body.strategist_name || "").trim();
      if (!strategist) return json({ error: "strategist_name required" }, 400);
      const first = strategist.split(/\s+/)[0].toLowerCase();

      // Find the strategist's list by first name; create it if missing.
      const lists: any[] = await trello("GET", `/boards/${BOARD}/lists`, { filter: "open" });
      let list = lists.find((l) => { const n = String(l.name || "").toLowerCase(); return n.includes(first) && n.includes("seo"); });
      if (!list) list = await trello("POST", "/lists", { name: `${strategist} SEO/AEO`, idBoard: BOARD, pos: "bottom" });

      const due = new Date(Date.now() + DUE_DAYS * 86400000).toISOString();
      const iv = (client.intake || {}) as Record<string, string>;
      const kws: string[] = [];
      for (let i = 1; i <= 5; i++) if (iv["kw" + i]) kws.push(`${iv["kw" + i]}${iv["kwl" + i] ? ` (${iv["kwl" + i]})` : ""}`);
      const desc = [
        `**${client.name || client.url}** — ${client.url}`,
        `Market: ${client.market || "—"} · Plan: ${client.tier || "—"}`,
        iv.description ? `\n${String(iv.description).slice(0, 600)}` : "",
        kws.length ? `\n**Target keywords:** ${kws.join("; ")}` : "",
        iv.landing_targets ? `**Landing pages:** ${String(iv.landing_targets).replace(/\n+/g, "; ").slice(0, 400)}` : "",
        `\nDue: ${DUE_DAYS} days per package. Open the client in the SEO console to start.`,
      ].filter(Boolean).join("\n");

      const card = await trello("POST", "/cards", {
        idList: list.id,
        name: `SEO/AEO package — ${client.name || client.url}`,
        desc, due,
      });
      const { error: uErr } = await supa.from("clients").update({ trello_card_id: card.id }).eq("id", client.id);
      return json({ ok: true, card_url: card.shortUrl || card.url, list: list.name, due,
        warning: uErr ? `card created but id not saved (${uErr.message}) — run platform_extras.sql` : null });
    }

    if (action === "comment") {
      if (!client.trello_card_id) return json({ error: "no Trello card on this client — submit to a specialist first" }, 400);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!text) return json({ error: "text required" }, 400);
      await trello("POST", `/cards/${client.trello_card_id}/actions/comments`, { text });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("trello fatal", e);
    return json({ error: String((e as any)?.message || e).slice(0, 400) }, 500);
  }
});
