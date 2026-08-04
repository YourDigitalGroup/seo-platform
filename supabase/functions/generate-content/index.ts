// ============================================================================
//  44i SEO/AEO Delivery System — generate-content Edge Function
//  Writes a content draft for a queued topic using the Anthropic API,
//  routing to the right Claude model and logging a revision.
//  Deploy in: Supabase Dashboard → Edge Functions → Deploy a new function
//  Name the function exactly:  generate-content
//  Required secret (already set):  ANTHROPIC_API_KEY
//  Auto-injected by Supabase:      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//  Input:  { "topic_id": "<uuid>", "instruction"?: "<rewrite notes>", "editor_id"?: "<uuid>" }
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// content_model enum  ->  actual API model string
const MODEL_API: Record<string, string> = {
  "opus-4-8":   "claude-opus-4-8",
  "sonnet-4-6": "claude-sonnet-4-6",
  "haiku-4-5":  "claude-haiku-4-5",
};
// output budget by content kind (keeps short items cheap)
const MAX_TOKENS: Record<string, number> = {
  blog: 4500, pillar: 6500, landing: 3500, service: 3500, gbp_post: 500, faq: 2000,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Build the writing brief for a given topic kind.
// v2: HARD RULES from the delivery-QA critique — fact provenance is a legal
// constraint (FTC fake-review rule), every piece ships publish-complete, and
// geo pages must be genuinely page-specific (anti-doorway).
function buildPrompt(kind: string, title: string, keyword: string, biz: string, market: string, town: string | null) {
  const loc = market ? ` serving ${market}` : "";
  const base =
    `You are an expert SEO and Answer Engine Optimization (AEO) copywriter writing for "${biz}"${loc}.\n\n` +
    `HARD RULES — violating any of these makes the output unusable:\n` +
    `1. FACT PROVENANCE (legal constraint, not style). The ONLY facts you know about this business are its name, its market, and the service implied by the keyword. NEVER invent:\n` +
    `   - testimonials, reviews, customer quotes or "what our clients say" content of ANY kind — the FTC prohibits fabricated reviews;\n` +
    `   - certifications, licenses, awards, partnerships or vendor relationships;\n` +
    `   - years in business, client counts, team size, or industries served;\n` +
    `   - response-time commitments, SLAs, uptime figures, or guarantees;\n` +
    `   - pricing, contract terms, or "no lock-in" style claims;\n` +
    `   - named tools/platforms, or capabilities like "24/7 monitoring".\n` +
    `   Where such a claim would strengthen the page, write the literal token [CLIENT TO CONFIRM: <specific question>] instead — a human resolves it before publish.\n` +
    `   Never write bracketed placeholders for contact details like [phone number]; write "call us or use our contact form" instead.\n` +
    `2. ANSWER-FIRST: open with a 40–60 word direct, self-contained answer an AI assistant could quote in isolation. Name the business and its city in it.\n` +
    `3. NO AGENCY BOILERPLATE: never use "we're your neighbors", "not a distant call center", "no jargon, no runaround", "enterprise-grade", "small issues never become major outages", or similar stock phrases.\n` +
    `4. Use the target keyword naturally — never stuff it. Clean Markdown, ONE H1, logical H2/H3s. No commentary or preamble.\n\n` +
    `DELIVERABLE HEADER — begin the output with exactly this block, one line each, then a blank line, then the content:\n` +
    `SLUG: /<lowercase-hyphenated-url-slug>\n` +
    `TITLE TAG: <50-60 char title tag>\n` +
    `META DESCRIPTION: <140-155 char meta description with a call to action>\n` +
    `H1: <the H1, worded differently from the title tag>\n`;
  const faqRule = (n: number, geoNote = "") =>
    `End with an FAQ section of ${n} question/answer pairs.${geoNote} Phrase questions the way a customer speaks (vary the openers — not all "What is…"). The first 40–60 words of each answer must be a complete, direct, standalone answer; never answer with "contact us to learn more".`;
  const kindBrief: Record<string, string> = {
    blog:    `Write a 600–800 word blog post titled "${title}" targeting the keyword "${keyword}". ${faqRule(3)}`,
    pillar:  `Write a comprehensive cornerstone/pillar article titled "${title}" targeting "${keyword}". 1200–1600 words, definition-first opening, question-based H2s, and at least one Markdown comparison table where the topic supports it (e.g. options, models, tiers). ${faqRule(6)}`,
    landing: `Write a conversion-focused landing page titled "${title}" for "${keyword}"${town ? `, specifically for ${town}` : ""}. ANTI-DOORWAY REQUIREMENTS: this page must be genuinely specific to its location — reference the town by name inside headings and body, speak to its proximity to the business's base only in safe generic terms ("a short drive away", never invented minutes), and DO NOT use a templated "Why [City] Businesses Choose Us" skeleton — structure this page differently from any sibling city page. Include benefit sections and one clear call to action. ${faqRule(5, town ? ` The FAQs must be ${town}-specific (e.g. service-area or response questions a ${town} customer would ask), not generic definitions.` : "")}`,
    service: `Write a service page titled "${title}" for "${keyword}". 600+ words, H1 containing the keyword naturally, benefit-led sections with substance (what the service includes, who it's for, how engagement works), and a contact CTA. No geo-templating. Include a Markdown comparison table if the topic has natural options to compare. ${faqRule(5)}`,
    gbp_post:`Write ONE Google Business Profile post about "${title}". STRICT SHAPE: 100–300 words of plain text, no headings, no lists, no markdown syntax, exactly one call to action. Never produce an article — a GBP post is a short update. Skip the DELIVERABLE HEADER block for this kind.`,
    faq:     `Write an FAQ set of 5–7 question/answer pairs about "${keyword}" for the page "${title}". Each answer: first 40–60 words fully answer the question standalone, then at most 2 more sentences. Format as ## question then the answer.`,
  };
  return `${base}\n${kindBrief[kind] ?? kindBrief.blog}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { topic_id, instruction, editor_id } = await req.json().catch(() => ({}));
    if (!topic_id) return json({ error: "topic_id is required" }, 400);

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // 1. Load the topic + business context (package -> client)
    const { data: topic, error: tErr } = await supa
      .from("content_topics")
      .select("id, package_id, title, target_keyword, kind, model, location, packages(client_id, clients(name, url, market))")
      .eq("id", topic_id).single();
    if (tErr || !topic) return json({ error: "topic not found", detail: tErr?.message }, 404);

    const client = (topic as any).packages?.clients ?? {};
    const biz = client.name || client.url || "the business";
    const market = client.market || "";
    const keyword = topic.target_keyword || topic.title;
    const modelEnum = topic.model || "sonnet-4-6";
    const apiModel = MODEL_API[modelEnum] || "claude-sonnet-4-6";
    const maxTokens = MAX_TOKENS[topic.kind] ?? 4000;

    await supa.from("content_topics").update({ status: "drafting" }).eq("id", topic_id);

    // 2. Build the prompt (rewrite-aware)
    let prompt = buildPrompt(topic.kind, topic.title, keyword, biz, market, (topic as any).location || null);
    const { data: existing } = await supa
      .from("content_drafts").select("id, revision, body")
      .eq("topic_id", topic_id).order("revision", { ascending: false }).limit(1).maybeSingle();
    if (instruction && existing?.body) {
      prompt += `\n\nHere is the current draft:\n\n${existing.body}\n\nRevise it according to these instructions: ${instruction}\n\nOutput only the revised content.`;
    }

    // 3. Call the Anthropic API
    const aRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: apiModel,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!aRes.ok) {
      const t = await aRes.text();
      await supa.from("content_topics").update({ status: "queued" }).eq("id", topic_id);
      return json({ error: "anthropic call failed", status: aRes.status, detail: t.slice(0, 500) }, 502);
    }
    const data = await aRes.json();
    const body = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    const usage = data.usage ?? null;
    if (!body) {
      await supa.from("content_topics").update({ status: "queued" }).eq("id", topic_id);
      return json({ error: "empty response from model", raw: data }, 502);
    }

    // 4. Save the draft (new draft, or new revision of an existing one)
    const newRev = existing ? existing.revision + 1 : 1;
    let draft_id = existing?.id;
    if (existing) {
      await supa.from("content_drafts").update({
        body, model: modelEnum, revision: newRev, kind: topic.kind, title: topic.title,
        last_instruction: instruction ?? null, edited_by: editor_id ?? null, updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
    } else {
      const { data: ins, error: dErr } = await supa.from("content_drafts").insert({
        package_id: topic.package_id, topic_id, kind: topic.kind, title: topic.title,
        body, model: modelEnum, revision: 1, last_instruction: instruction ?? null, edited_by: editor_id ?? null,
      }).select("id").single();
      if (dErr || !ins) return json({ error: "failed to save draft", detail: dErr?.message }, 500);
      draft_id = ins.id;
    }

    // 5. Log the revision and mark the topic drafted
    await supa.from("content_revisions").insert({
      draft_id, revision: newRev, source: "rewrite", instruction: instruction ?? null,
      model: modelEnum, body, created_by: editor_id ?? null,
    });
    await supa.from("content_topics").update({ status: "drafted" }).eq("id", topic_id);

    return json({ ok: true, draft_id, revision: newRev, model: apiModel, kind: topic.kind, chars: body.length, usage });
  } catch (e) {
    console.error("generate-content fatal", e);
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
});
