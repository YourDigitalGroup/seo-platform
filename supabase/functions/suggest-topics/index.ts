// ============================================================================
//  suggest-topics Edge Function
// ----------------------------------------------------------------------------
//  When the audit's keyword pools run dry (small sites, thin SERP data), the
//  strategist model proposes candidate topics from the OWNER'S OWN DESCRIPTION
//  of the business (clients.intake.description) combined with everything the
//  latest audit knows: business type, services, trade area, opportunities,
//  content gaps. Every candidate passes the same deterministic gates as
//  audit-generated topics (junk/near-me/bare-geo rejection + intent-level
//  dedupe against the client's existing pieces). Nothing is queued here —
//  the console shows the list and a human picks what to add.
//
//  Deploy: Edge Functions → Deploy new function → name it exactly: suggest-topics
//  Input:  { "client_id": "<uuid>" }
//  Returns { ok, suggestions: [{ keyword, kind, rationale }], rejected: [...] }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ── The same keyword gates run-audit uses (kept in sync by hand) ─────────────
const US_STATES = new Set(("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc " +
  "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada newhampshire newjersey newmexico newyork northcarolina northdakota ohio oklahoma oregon pennsylvania rhodeisland southcarolina southdakota tennessee texas utah vermont virginia washington westvirginia wisconsin wyoming").split(" "));
const junkKw = (k: unknown) => { const t = String(k || "").trim().toLowerCase(); return t.length < 4 || /^[a-z]{2}\.?$/.test(t) || US_STATES.has(t.replace(/\s+/g, "")); };
const rejectReason = (k: unknown, geos: string[]): string | null => {
  const t = String(k || "").trim().toLowerCase();
  if (junkKw(t)) return "junk fragment / bare state";
  if (/^\d{5}(-\d{4})?$/.test(t)) return "bare ZIP";
  if (t.split(/\s+/).length < 2) return "single word";
  if (/\bnear me\b/.test(t)) return "near-me query";
  const bare = t.replace(/,?\s*[a-z]{2}$/, "").trim();
  if (geos.some((g) => { const town = String(g).split(",")[0].trim().toLowerCase(); return town && (bare === town || t === town); })) return "bare location";
  return null;
};
const KW_FILLERS = new Set(["and", "the", "a", "an", "in", "for", "of", "services", "service", "solutions", "company", "provider", "llc", "inc"]);
const kwKey = (k: unknown) => [...new Set(String(k || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && !KW_FILLERS.has(t)))].sort().join(" ");
const sameIntent = (a: string, b: string) => { if (!a || !b) return false; if (a === b) return true;
  const A = a.split(" "), B = b.split(" "); const [s, l] = A.length <= B.length ? [A, new Set(B)] : [B, new Set(A)];
  return s.every((t) => l.has(t)); };
const KINDS = new Set(["blog", "service", "landing", "pillar", "faq", "gbp_post"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { client_id } = await req.json().catch(() => ({}));
    if (!client_id) return json({ error: "client_id is required" }, 400);
    const AI_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!AI_KEY) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: client } = await supa.from("clients").select("*").eq("id", client_id).single();
    if (!client) return json({ error: "client not found" }, 404);
    const { data: aud } = await supa.from("audits").select("raw").eq("client_id", client_id).order("run_at", { ascending: false }).limit(1).maybeSingle();
    const raw = aud?.raw || {};
    const biz = raw.business || {};
    const ta = raw.tradeArea || {};
    const geos = [ta.primary, ...(ta.secondary || [])].filter(Boolean).map(String);

    // existing pieces claim their intent — suggestions must not collide
    const { data: exT } = await supa.from("content_topics")
      .select("target_keyword, title, status, packages!inner(client_id)").eq("packages.client_id", client_id);
    const claimed = (exT || []).filter((t: any) => t.status !== "retired").map((t: any) => kwKey(t.target_keyword || t.title));

    const desc = (client.intake && client.intake.description) || "";
    // Owner-specified target keywords (intake kw1..kw5 + location) rank first.
    const ivS = (client.intake || {}) as Record<string, string>;
    const targetKw: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const k = String(ivS["kw" + i] || "").trim();
      if (k) targetKw.push(k + (ivS["kwl" + i] ? ` (${String(ivS["kwl" + i]).trim()})` : ""));
    }
    const landingT = String(ivS.landing_targets || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const context = [
      `Business: ${client.name || client.url} (${client.url}) in ${ta.primary || client.market || ""}.`,
      desc ? `OWNER'S DESCRIPTION (authoritative): ${desc}` : "",
      targetKw.length ? `OWNER'S TARGET KEYWORDS (highest priority — suggest topics that win these first): ${targetKw.join("; ")}.` : "",
      landingT.length ? `OWNER'S TARGETED LANDING PAGES (plan these as landings first): ${landingT.join("; ")}.` : "",
      biz.type ? `Classified type: ${biz.type}. Services: ${(biz.services || []).join(", ")}.` : "",
      (ta.secondary || []).length ? `Trade-area towns: ${(ta.secondary || []).join(", ")}.` : "",
      (raw.opportunities || []).length ? `Keyword opportunities (proven demand): ${(raw.opportunities || []).slice(0, 8).map((o: any) => `${o.keyword} (vol ${o.volume})`).join("; ")}.` : "",
      (raw.coreKeywords || []).length ? `Researched trade-area keywords: ${(raw.coreKeywords || []).slice(0, 10).map((k: any) => k.keyword).join("; ")}.` : "",
      claimed.length ? `ALREADY COVERED (do NOT suggest anything answering the same search): ${(exT || []).filter((t: any) => t.status !== "retired").slice(0, 20).map((t: any) => t.target_keyword || t.title).join("; ")}.` : "",
    ].filter(Boolean).join("\n");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1400,
        system: "You are a local-SEO content strategist. Return ONLY compact JSON, no prose, no markdown fences: " +
          `[{"keyword":"<2-6 word buyer or informational search phrase>","kind":"blog|service|landing|pillar|faq|gbp_post","rationale":"<one short clause>"}]. ` +
          "Rules: every keyword must be a real search someone in the trade area would type; NO 'near me' phrases; NO bare city/state names; NO single words; nothing that duplicates the ALREADY COVERED list's intent; landings must pair a service with a town; blogs are informational questions/guides; invent no business facts in rationales.",
        messages: [{ role: "user", content: `${context}\n\nSuggest 12 topics.` }],
      }),
    });
    if (!r.ok) return json({ error: `anthropic ${r.status}`, detail: (await r.text()).slice(0, 300) }, 502);
    const d = await r.json();
    const text = (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    let list: any[] = [];
    try { list = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { return json({ error: "unparseable model reply", raw: text.slice(0, 300) }, 502); }

    // deterministic gates — the model's list is candidates, not truth
    const rejected: any[] = []; const out: any[] = []; const seen: string[] = [...claimed];
    for (const s of Array.isArray(list) ? list : []) {
      const kw = String(s?.keyword || "").trim();
      const kind = KINDS.has(String(s?.kind)) ? String(s.kind) : "blog";
      const why = rejectReason(kw, geos);
      if (why) { rejected.push({ keyword: kw, reason: why }); continue; }
      const key = kwKey(kw);
      if (seen.some((k) => sameIntent(k, key))) { rejected.push({ keyword: kw, reason: "duplicate intent" }); continue; }
      seen.push(key);
      out.push({ keyword: kw, kind, rationale: String(s?.rationale || "").slice(0, 140) });
    }
    return json({ ok: true, suggestions: out, rejected });
  } catch (e) {
    return json({ error: "unhandled", detail: String((e as any)?.stack || e).slice(0, 500) }, 500);
  }
});
