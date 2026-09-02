// ============================================================================
//  trello — the console's handoff to the delivery board.
// ----------------------------------------------------------------------------
//  Configured from the console (Team & access → Trello integration), stored
//  in app_settings key 'trello' (trello_settings.sql):
//    { board_id, title_template, comment_template, lists: { <profile_id>: <trello_list_id> } }
//
//  Actions:
//   · submit  — "Submit to SEO/AEO specialist" (Setup tab). Creates a card:
//       - in the COLUMN mapped to the chosen strategist (settings.lists),
//         falling back to a by-name list match / creation;
//       - titled from the template — variables {domain} {client} {group}
//         {plan} {market} — e.g. "[SEO Package] - {domain} - {group}";
//       - due in 2 days;
//       - with one CHECKLIST PER MONTH of the campaign ("Month 1", "Month
//         2", …), items = that month's deliverables (skipped months from a
//         mid-campaign import are left out);
//       - tagging the strategist: added as a card member and @mentioned in
//         a comment, via profiles.trello_username.
//   · comment — approval-trail comments on the client's card.
//   · lists   — board columns (id + name) for the settings dashboard.
//
//  Secrets: TRELLO_KEY, TRELLO_TOKEN (trello.com/power-ups/admin).
//  TRELLO_BOARD_ID is an optional fallback — the dashboard's board id wins.
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
    if (!KEY || !TOKEN) return json({ error: "Trello not configured — set TRELLO_KEY and TRELLO_TOKEN under Edge Functions → trello → Secrets" }, 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // signed-in staff only
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await supa.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "sign in required" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // Console-managed settings (board id, title template, strategist→column).
    let settings: any = {};
    try {
      const { data: st } = await supa.from("app_settings").select("value").eq("key", "trello").maybeSingle();
      settings = st?.value || {};
    } catch (_) { /* trello_settings.sql not run yet */ }
    const BOARD = String(settings.board_id || Deno.env.get("TRELLO_BOARD_ID") || "").trim();

    const auth = `key=${KEY}&token=${TOKEN}`;
    const trello = async (method: string, path: string, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      const r = await fetch(`https://api.trello.com/1${path}?${auth}${qs ? "&" + qs : ""}`, { method });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Trello ${method} ${path} → HTTP ${r.status}: ${txt.slice(0, 200)}`);
      try { return JSON.parse(txt); } catch { return txt; }
    };

    if (action === "lists") {
      if (!BOARD) return json({ error: "no board id — set it in Team & access → Trello integration (or the TRELLO_BOARD_ID secret)" }, 400);
      const lists: any[] = await trello("GET", `/boards/${BOARD}/lists`, { filter: "open" });
      return json({ ok: true, board_id: BOARD, lists: lists.map((l) => ({ id: l.id, name: l.name })) });
    }

    if (!body.client_id) return json({ error: "client_id required" }, 400);
    const { data: client } = await supa.from("clients").select("*").eq("id", body.client_id).maybeSingle();
    if (!client) return json({ error: "no such client" }, 404);

    if (action === "submit") {
      if (!BOARD) return json({ error: "no board id — set it in Team & access → Trello integration" }, 400);
      const strategist = String(body.strategist_name || "").trim();
      const profileId = String(body.strategist_profile_id || "").trim();
      if (!strategist) return json({ error: "strategist_name required" }, 400);
      const warnings: string[] = [];

      // ── Column: the strategist's mapped list; fallback = find/create by name
      let listId = (settings.lists || {})[profileId] || "";
      let listName = "";
      if (listId) {
        listName = "(mapped column)";
      } else {
        const first = strategist.split(/\s+/)[0].toLowerCase();
        const lists: any[] = await trello("GET", `/boards/${BOARD}/lists`, { filter: "open" });
        let list = lists.find((l) => { const n = String(l.name || "").toLowerCase(); return n.includes(first) && n.includes("seo"); });
        if (!list) list = await trello("POST", "/lists", { name: `${strategist} SEO/AEO`, idBoard: BOARD, pos: "bottom" });
        listId = list.id; listName = list.name;
        warnings.push("no column mapped for this strategist — used/created a list by name; map it in Team & access → Trello integration");
      }

      // ── Title from the template ({domain} {client} {group} {plan} {market})
      let groupName = "";
      if (client.partner_group_id) {
        const { data: g } = await supa.from("partner_groups").select("name").eq("id", client.partner_group_id).maybeSingle();
        groupName = g?.name || "";
      }
      const vars: Record<string, string> = {
        domain: String(client.url || ""), client: String(client.name || client.url || ""),
        group: groupName, plan: String(client.tier || ""), market: String(client.market || ""),
      };
      const template = String(settings.title_template || "[SEO Package] - {domain} - {group}");
      const name = template.replace(/\{(domain|client|group|plan|market)\}/gi, (_, k) => vars[k.toLowerCase()] || "").replace(/\s{2,}/g, " ").trim();

      // ── Strategist tagging: card member + @mention (profiles.trello_username)
      let memberId = "", atName = "";
      if (profileId) {
        try {
          const { data: prof } = await supa.from("profiles").select("trello_username").eq("id", profileId).maybeSingle();
          atName = String(prof?.trello_username || "").replace(/^@/, "").trim();
        } catch (_) { /* trello_settings.sql not run yet */ }
      }
      if (atName) {
        try { const m = await trello("GET", `/members/${encodeURIComponent(atName)}`, { fields: "id,username" }); memberId = m?.id || ""; }
        catch (_) { warnings.push(`Trello user @${atName} not found — check the @username in Team & access`); }
      } else {
        warnings.push("no Trello @username on this strategist — set it in Team & access to enable tagging");
      }

      const due = new Date(Date.now() + DUE_DAYS * 86400000).toISOString();
      const iv = (client.intake || {}) as Record<string, string>;
      const kws: string[] = [];
      for (let i = 1; i <= 40; i++) if (iv["kw" + i]) kws.push(`${iv["kw" + i]}${iv["kwl" + i] ? ` (${iv["kwl" + i]})` : ""}`);
      const desc = [
        `**${client.name || client.url}** — ${client.url}`,
        `Market: ${client.market || "—"} · Plan: ${client.tier || "—"} · Group: ${groupName || "—"}`,
        iv.description ? `\n${String(iv.description).slice(0, 600)}` : "",
        kws.length ? `\n**Target keywords:** ${kws.join("; ")}` : "",
        iv.landing_targets ? `**Landing pages:** ${String(iv.landing_targets).replace(/\n+/g, "; ").slice(0, 400)}` : "",
        `\nDue: ${DUE_DAYS} days per package. Open the client in the SEO console to start.`,
      ].filter(Boolean).join("\n");

      const card = await trello("POST", "/cards", {
        idList: listId, name, desc, due, ...(memberId ? { idMembers: memberId } : {}),
      });

      // ── One checklist per campaign month, items = that month's deliverables
      const { data: dels } = await supa.from("deliverables")
        .select("name, month_offset, state").eq("client_id", client.id)
        .neq("state", "skipped").order("month_offset", { ascending: true }).limit(400);
      const byMonth: Record<number, string[]> = {};
      (dels || []).forEach((d: any) => {
        const m = Number(d.month_offset) || 1;
        (byMonth[m] = byMonth[m] || []).push(String(d.name || "").replace(/\s*—\s*Month\s*\d+\s*$/i, ""));
      });
      let checkItems = 0;
      for (const m of Object.keys(byMonth).map(Number).sort((a, b) => a - b)) {
        const cl = await trello("POST", "/checklists", { idCard: card.id, name: `Month ${m}` });
        for (const item of byMonth[m].slice(0, 30)) {
          await trello("POST", `/checklists/${cl.id}/checkItems`, { name: item.slice(0, 250) });
          checkItems++;
        }
      }
      if (!Object.keys(byMonth).length) warnings.push("no campaign deliverables found — seed the campaign to get the month-by-month checklists");

      // Handoff comment from the editable template (Team & access → Trello
      // integration). Variables: {strategist_handle} {client} {domain}
      // {group} {plan} {market}. Posted whenever a template is set — Trello
      // mentions work by handle text even when member resolution failed.
      const commentTemplate = String(settings.comment_template ??
        "@{strategist_handle} This {plan} package is ready to be built out for {client}. @kellarelliot please add the plugin to the site (WordPress only).");
      if (commentTemplate.trim()) {
        const cvars: Record<string, string> = { ...vars, strategist_handle: atName || strategist };
        const commentText = commentTemplate
          .replace(/\{(strategist_handle|domain|client|group|plan|market)\}/gi, (_, k) => cvars[k.toLowerCase()] || "")
          .replace(/\s{2,}/g, " ").trim();
        // A Trello @mention only NOTIFIES people who are on the card/board —
        // plain text otherwise. Resolve every @handle in the comment and add
        // them to the card first (e.g. @kellarelliot gets pinged for the
        // plugin install), then post the comment.
        const handles = [...new Set((commentText.match(/@([A-Za-z0-9_.]+)/g) || []).map((h) => h.slice(1)))];
        for (const h of handles) {
          try {
            const m = await trello("GET", `/members/${encodeURIComponent(h)}`, { fields: "id,username" });
            if (m?.id) await trello("POST", `/cards/${card.id}/idMembers`, { value: m.id });
          } catch (_) { if (h !== atName) warnings.push(`@${h} not found on Trello (or already on the card)`); }
        }
        try {
          await trello("POST", `/cards/${card.id}/actions/comments`, { text: commentText.slice(0, 1000) });
        } catch (_) { warnings.push("card created but the handoff comment failed"); }
      }

      const { error: uErr } = await supa.from("clients").update({ trello_card_id: card.id }).eq("id", client.id);
      if (uErr) warnings.push(`card created but id not saved (${uErr.message}) — run platform_extras.sql`);
      return json({ ok: true, card_url: card.shortUrl || card.url, list: listName, title: name, due,
        months: Object.keys(byMonth).length, check_items: checkItems, tagged: !!memberId,
        warning: warnings.length ? warnings.join("; ") : null });
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
