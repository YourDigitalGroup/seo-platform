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
  blog: 4000, pillar: 6000, landing: 2500, service: 2500, gbp_post: 500, faq: 2000,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Build the writing brief for a given topic kind
function buildPrompt(kind: string, title: string, keyword: string, biz: string, market: string) {
  const loc = market ? ` serving ${market}` : "";
  const base =
    `You are an expert SEO and Answer Engine Optimization (AEO) copywriter writing for "${biz}"${loc}. ` +
    `Write in clear, natural, trustworthy prose. Open with a direct, declarative answer paragraph that an AI ` +
    `assistant could quote verbatim. Use the target keyword naturally — never stuff it. Output clean Markdown ` +
    `with a single H1 and logical H2/H3 subheads. Do not include commentary, notes, or a preamble — output only the content.`;
  const kindBrief: Record<string, string> = {
    blog:    `Write a 600–800 word blog post titled "${title}" targeting the keyword "${keyword}". Include a short FAQ of 2–3 questions at the end.`,
    pillar:  `Write a comprehensive cornerstone/pillar article titled "${title}" targeting "${keyword}". 1200–1600 words, scannable, authoritative, with a clear FAQ section formatted for FAQPage schema.`,
    landing: `Write a conversion-focused landing page titled "${title}" for the service/topic "${keyword}". Include a hero value statement, benefit sections, trust signals, and a clear call to action.`,
    service: `Write a service page titled "${title}" for "${keyword}". 600+ words, an H1 with the exact keyword, benefit-led sections, local relevance, and a booking/contact CTA.`,
    gbp_post:`Write a short Google Business Profile post (max 1500 characters) about "${title}". Friendly, local, with one clear call to action. No headings.`,
    faq:     `Write an FAQ set of 5–7 question/answer pairs about "${keyword}" for the page "${title}". Each answer 2–4 sentences, declarative, quotable. Format as ## question then answer.`,
  };
  return `${base}\n\n${kindBrief[kind] ?? kindBrief.blog}`;
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
      .select("id, package_id, title, target_keyword, kind, model, packages(client_id, clients(name, url, market))")
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
    let prompt = buildPrompt(topic.kind, topic.title, keyword, biz, market);
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
