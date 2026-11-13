// ============================================================================
//  Remediation Engine — generate-fixes Edge Function
// ----------------------------------------------------------------------------
//  Fills in the actual deployable fix for one or more approved fix rows.
//  The audit stages "suggested" fixes (kind + target page + current value +
//  context). When a human approves, the console calls this with the fix id(s);
//  this function writes the artifact and flips the row to "ready" for review.
//  Nothing is published — output is staged for the team to edit/approve.
//
//  What it produces per kind:
//    title_tag / meta_description / h1            → AI copy in after_text
//    heading / page_copy                          → AI copy in after_text
//    image_alt                                    → AI alt list (fetches the
//                                                   page to read the <img> tags)
//    faq_schema                                   → AI Q&A + FAQPage JSON-LD
//    local_business_schema / org_schema /
//    person_schema / breadcrumb_schema /
//    aggregate_rating_schema / website_schema     → JSON-LD scaffold (template,
//                                                   filled from context; no AI)
//    internal_link                                → AI internal-link plan
//    gbp_post                                     → AI Business-Profile post
//    robots_txt / sitemap_xml / canonical /
//    security_headers / redirect_map / favicon    → deterministic deployable
//                                                   artifacts (v4 directive
//                                                   engine; no AI)
//    llms_txt / og_tags                           → AI-written artifacts for
//                                                   AI-crawler guidance and
//                                                   social/rich cards
//
//  Deploy: Edge Functions → Deploy new function → name it exactly: generate-fixes
//  Secret (already set): the AI writer key.  Input: { "fix_ids": ["..."] }  or  { "fix_id": "..." }
//  Optional rewrite: { "fix_id": "...", "instruction": "make it punchier", "editor_id": "uuid" }
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

// ── Caller gate (QA 2026-10-28). verify_jwt alone is not access control here:
// the public anon key shipped in the console is itself a valid JWT, and email
// sign-up is open. Every request must come from the service role (scheduler,
// function-to-function) or a staff member (a row in profiles), optionally
// holding one of `roles`.
async function gateCaller(req: Request, roles?: string[]): Promise<{ userId: string | null; role: string } | Response> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!tok) return json({ error: "sign in required" }, 401);
  if (svc && tok === svc) return { userId: null, role: "service" };
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, svc, { auth: { persistSession: false } });
  const { data } = await admin.auth.getUser(tok);
  if (!data?.user) return json({ error: "sign in required" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (!prof) return json({ error: "staff only — this account has no staff profile" }, 403);
  if (roles && !roles.includes(String(prof.role))) return json({ error: "your role can't do this" }, 403);
  return { userId: data.user.id, role: String(prof.role) };
}

// Which model writes which kind (kept internal; never surfaced to the team).
const MODEL_FOR: Record<string, string> = {
  page_copy: "claude-opus-4-8", faq_schema: "claude-sonnet-4-6",
  internal_link: "claude-sonnet-4-6", llms_txt: "claude-sonnet-4-6",
  _default: "claude-haiku-4-5",
};
const MODEL_ENUM: Record<string, string> = {
  "claude-opus-4-8": "opus-4-8", "claude-sonnet-4-6": "sonnet-4-6", "claude-haiku-4-5": "haiku-4-5",
};

// Kinds whose output is a JSON-LD scaffold we can build deterministically.
const SCHEMA_KINDS = new Set([
  "local_business_schema","org_schema","person_schema","breadcrumb_schema","aggregate_rating_schema","website_schema",
]);
// v4 kinds whose deployable artifact is a deterministic file/snippet (no AI).
const FILE_KINDS = new Set([
  "robots_txt","sitemap_xml","canonical","security_headers","redirect_map","favicon",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const who = await gateCaller(req);
  if (who instanceof Response) return who;

  // The AI writer key (secret name unchanged so the deployed config keeps working).
  const AI_KEY = (await platformKey("ANTHROPIC_API_KEY"));
  try {
    const body = await req.json().catch(() => ({}));
    const ids: string[] = (Array.isArray(body.fix_ids) ? body.fix_ids : (body.fix_id ? [body.fix_id] : [])).map(String);
    const instruction: string | null = body.instruction ?? null;
    // the audit trail records the real caller; only the service role may name one
    const editor_id: string | null = who.userId ?? body.editor_id ?? null;
    if (!ids.length) return json({ error: "fix_ids (or fix_id) required" }, 400);
    if (ids.length > 60) return json({ error: "at most 60 fixes per call" }, 400);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Fact-provenance wall applied to EVERY AI-written artifact (legal
    // constraint — the FTC prohibits fabricated reviews/testimonials, and the
    // model knows nothing about this business beyond name/city/keyword).
    const PROVENANCE =
      "HARD RULE: you know NOTHING about this business except its name, city and the keyword. " +
      "Never invent testimonials/reviews/quotes, certifications, awards, years in business, client counts, " +
      "SLAs or response-time commitments, pricing/contract claims, named tools, or capabilities like '24/7 monitoring'. " +
      "If such a claim would help, write the token [CLIENT TO CONFIRM: <question>] instead. " +
      "Never output bracketed contact placeholders like [phone number] — say 'call us or use our contact form'. ";
    // Call the AI writer once; return plain text.
    const writeAI = async (model: string, system: string, user: string, maxTokens = 700): Promise<string> => {
      if (!AI_KEY) throw new Error("AI writer key is not set");
      const wsid = (await platformKey("ANTHROPIC_WORKSPACE_ID")) || "";  // needed by keys not scoped to one workspace
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json",
          ...(wsid ? { "anthropic-workspace-id": wsid } : {}) },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) throw new Error(`AI writer ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      if (data.stop_reason === "max_tokens") throw new Error(`AI output hit the ${maxTokens}-token limit and was cut off`);
      return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    };

    const results: any[] = [];
    for (const id of ids) {
      // Load the fix + its client (via the audit) for naming/locale context.
      const { data: fix, error: fErr } = await supa.from("fixes").select("*").eq("id", id).single();
      if (fErr || !fix) { results.push({ id, error: "fix not found" }); continue; }
      const { data: audit } = await supa.from("audits").select("client_id").eq("id", fix.audit_id).single();
      const { data: client } = audit
        ? await supa.from("clients").select("id, name, url, market, intake, gbp_place_id").eq("id", audit.client_id).single()
        : { data: null };

      const ctx = fix.context || {};
      const name = ctx.business_name || (client?.url || "").replace(/^https?:\/\//, "").replace(/^www\./, "");
      const city = ctx.city || client?.market || "";
      const kw = ctx.target_keyword || "";
      const page = fix.target_page || client?.url || "";
      const kind = fix.kind as string;

      try {
        let after_text: string | null = null;
        let schema_jsonld: unknown = null;
        let usedModel: string | null = null;

        if (SCHEMA_KINDS.has(kind)) {
          // ── Deterministic JSON-LD scaffolds (no AI; reliable + free) ──────────
          // Real data only: intake facts + the pinned Business Profile
          // (coordinates, structured hours, rating). A field we don't have is
          // left out — never a "[STREET]" placeholder that ships to a site.
          const facts = await businessFacts(client, ctx);
          const built = buildSchema(kind, { name, city, page, kw, facts });
          schema_jsonld = built.jsonld;
          fix.context = { ...(fix.context || {}), schema_missing: built.missing };
          after_text = schema_jsonld
            ? "<script type=\"application/ld+json\">\n" + JSON.stringify(schema_jsonld, null, 2) + "\n</script>"
            : `Not generated — ${built.missing.join(", ")} missing. Fill it in on the client's intake (or pin the Business Profile) and regenerate.`;

        } else if (FILE_KINDS.has(kind)) {
          // ── Deterministic deployable files/snippets (v4; no AI) ───────────────
          after_text = buildFileArtifact(kind, { name, city, page, ctx });

        } else if (kind === "llms_txt") {
          // Built from facts, not invented: intake + the audited pages. Also
          // assembles llms-full.txt (every key page as Markdown) for AI tools
          // that read a whole site in one file.
          const facts = await businessFacts(client, ctx);
          const out = await buildLlms(facts, fix.audit_id, supa);
          after_text = out.llms;
          fix.context = { ...(fix.context || {}), llms_full: out.full, llms_pages: out.pages };

        } else if (kind === "image_alt") {
          // Fetch the page, read <img> tags missing alt, write alt text for each.
          const imgs = await imagesMissingAlt(page);
          if (!imgs.length) { after_text = "No images missing alt text were found on the live page."; }
          else {
            const model = MODEL_FOR._default; usedModel = model;
            const list = imgs.map((s, i) => `${i + 1}. ${s}`).join("\n");
            after_text = await writeAI(model,
              "You write concise, descriptive, accessibility-correct alt text. No quotes, no 'image of'. Max 12 words each.",
              `Business: ${name} in ${city}. For each image (filename/nearby text given), write alt text. Return a numbered list only.\n${list}`,
              500);
          }

        } else {
          // ── AI copy kinds ─────────────────────────────────────────────────────
          const model = MODEL_FOR[kind] || MODEL_FOR._default; if (kind !== "faq_schema") usedModel = model;
          // a rewrite revises the CURRENT copy rather than starting over
          const before = instruction && fix.after_text ? `${fix.before_text || ""}\n\nCURRENT DRAFT (revise this):\n${fix.after_text}` : (fix.before_text || "");
          // FAQPage markup is only valid for Q&As the visitor can read on the
          // page (Google's rule, and the audit's schema_mirror check). When the
          // page already shows questions + answers, mark up THOSE word for word
          // — no AI. Otherwise the written FAQ ships with its visible section
          // (faq_source "written": the deploy file carries faq_html, WordPress
          // prints it, other CMSs get a manual task to add it).
          const absPage = /^\//.test(page) ? `https://${String(client?.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "")}${page}` : page;
          const onPage = kind === "faq_schema" && !instruction ? await pageFaqs(absPage) : [];
          if (onPage.length >= 3) {
            after_text = onPage.map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n\n");
            schema_jsonld = faqToJsonLd(after_text);
            fix.context = { ...(fix.context || {}), faq_source: "page", faq_count: onPage.length };
          } else {
            usedModel = model;
            const { system, user, max } = promptFor(kind, { name, city, kw, page, before, instruction });
            after_text = await writeAI(model, PROVENANCE + system, user, max);
            if (kind === "faq_schema") { schema_jsonld = faqToJsonLd(after_text); fix.context = { ...(fix.context || {}), faq_source: "written" }; }
          }
        }

        // A fix already live on the site keeps its pushed/verified status (the
        // report counts those); everything else lands back in review.
        const keep = fix.status === "pushed" || fix.status === "verified";
        const update: Record<string, unknown> = {
          after_text, schema_jsonld, status: keep ? fix.status : "ready", updated_at: new Date().toISOString(),
          revision: (fix.revision || 1) + (instruction ? 1 : 0),
        };
        if (usedModel) update.model = MODEL_ENUM[usedModel] ?? null;
        if ((kind === "faq_schema" || kind === "llms_txt" || SCHEMA_KINDS.has(kind)) && fix.context) update.context = fix.context;
        if (instruction) update.last_instruction = instruction;
        if (editor_id) update.edited_by = editor_id;
        const { error: upErr } = await supa.from("fixes").update(update).eq("id", id);
        if (upErr) { console.error(`fix ${id} save failed: ${upErr.message}`); results.push({ id, kind, error: upErr.message }); continue; }
        results.push({ id, kind, status: update.status });
      } catch (e) {
        // leave re-runnable — but never knock a live (pushed/verified) fix out of the report
        if (fix.status !== "pushed" && fix.status !== "verified") await supa.from("fixes").update({ status: "suggested" }).eq("id", id);
        results.push({ id, kind, error: String(e) });
      }
    }
    return json({ ok: true, results });
  } catch (e) {
    return json({ error: "unhandled", detail: String((e as any)?.stack || e).slice(0, 500) }, 500);
  }
});

// ── Prompt library for the AI copy kinds ──────────────────────────────────────
function promptFor(kind: string, a: { name: string; city: string; kw: string; page: string; before: string; instruction: string | null }) {
  const loc = a.city ? ` in ${a.city}` : "";
  const tail = a.instruction ? `\n\nRevise per this instruction: ${a.instruction}` : "";
  switch (kind) {
    case "title_tag":
      return { max: 200, system: "You write SEO title tags. 50–60 characters. Include the primary keyword and city. No quotes. Output only the title text.",
        user: `Business: ${a.name}${loc}. Primary keyword: "${a.kw}". Page: ${a.page}. Current title: "${a.before}". Write one improved title tag.${tail}` };
    case "meta_description":
      return { max: 250, system: "You write meta descriptions. 150–160 characters. Include the keyword, a clear value proposition, and a call to action. No quotes. Output only the description.",
        user: `Business: ${a.name}${loc}. Keyword: "${a.kw}". Page: ${a.page}. Current: "${a.before}". Write one improved meta description.${tail}` };
    case "h1":
      return { max: 120, system: "You write H1 headings. One clear, keyword-relevant H1. No quotes. Output only the heading text.",
        user: `Business: ${a.name}${loc}. Keyword: "${a.kw}". Page: ${a.page}. Write one strong H1.${tail}` };
    case "heading":
      return { max: 300, system: "You write a clean H2/H3 heading outline that improves topical structure and answer-engine readability. Output a short list of headings only.",
        user: `Business: ${a.name}${loc}. Keyword: "${a.kw}". Page: ${a.page}. Propose 4–6 headings.${tail}` };
    case "page_copy":
      return { max: 1600, system: "You write conversion-focused, locally-relevant web page copy with clear headings and a strong CTA. Output clean copy with H2/H3 markers.",
        user: `Write expanded page copy for ${a.name}${loc}. Target keyword: "${a.kw}". Page: ${a.page}. The current page is thin; produce 500–700 words of genuinely useful content.${tail}` };
    case "faq_schema":
      return { max: 900, system: "You write FAQ content for answer-engine optimization. Return 5–6 question/answer pairs. Each answer is 40–70 words: the first sentence answers the question completely on its own (no lead-in like 'Great question' or 'At Company…'), then one or two sentences of specific supporting detail. Plain factual language, no fluff, no 'contact us to learn more'. Format exactly as 'Q: ...' then 'A: ...' lines.",
        user: `Business: ${a.name}${loc}. Topic/keyword: "${a.kw}". Write FAQs real customers ask, with direct answers.${tail}` };
    case "internal_link":
      return { max: 600, system: "You produce an internal-linking plan: for each suggested anchor text, give the source page idea and target page. Output a concise list.",
        user: `Business: ${a.name}${loc}. Keyword theme: "${a.kw}". Suggest 5 internal links that strengthen topical relevance and funnel toward conversion pages.${tail}` };
    case "gbp_post":
      return { max: 700, system: "You write Google Business Profile posts. STRICT SHAPE: 100-300 words of plain text, no headings, no lists, no markdown, exactly one call to action. Never an article. Output only the post.",
        user: `Business: ${a.name}${loc}. Theme/keyword: "${a.kw}". Write one Business Profile post for this month.${tail}` };
    case "llms_txt":
      return { max: 900, system: "You write llms.txt files — the markdown file AI assistants read to understand a website. Format: '# <Business Name>' heading, one-paragraph plain-language summary, then '## Services' and '## Key Pages' sections with markdown links. Factual, declarative, no marketing fluff. Output only the file content.",
        user: `Business: ${a.name}${loc}. Site: ${a.page}. Primary keyword/services: "${a.kw}". Write the llms.txt for this local business.${tail}` };
    case "og_tags":
      return { max: 500, system: "You write social meta tags. Output ONLY a ready-to-paste HTML block: og:title, og:description, og:image (use the placeholder [IMAGE_URL] if unknown), og:url, og:type, twitter:card (summary_large_image), twitter:title, twitter:description.",
        user: `Business: ${a.name}${loc}. Page: ${a.page}. Keyword: "${a.kw}". Current title/description: "${a.before}". Write the complete Open Graph + Twitter card block.${tail}` };
    default:
      return { max: 400, system: "You are an expert SEO/AEO copywriter. Produce the requested fix as clean, deployable text.",
        user: `Kind: ${kind}. Business: ${a.name}${loc}. Keyword: "${a.kw}". Current: "${a.before}".${tail}` };
  }
}

// ── The page's own Q&As: a question heading (h2–h5, <summary>, <dt>) ending in
// "?" plus the paragraph(s) after it, text exactly as rendered. Used to mark
// up an existing FAQ word for word instead of inventing questions.
async function pageFaqs(url: string): Promise<{ q: string; a: string }[]> {
  try {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; 44i-fixes/1.0)" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const html = (await r.text()).replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ");
    const txt = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
      .replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
      .replace(/\s+/g, " ").trim();
    const out: { q: string; a: string }[] = []; const seen = new Set<string>();
    const re = /<(h[2-5]|summary|dt)\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*?)(?=<(?:h[1-5]|summary|dt)\b|<\/(?:main|article|body)>|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 8) {
      const q = txt(m[2]);
      if (!/\?$/.test(q) || q.length > 200 || seen.has(q.toLowerCase())) continue;
      const paras = [...m[3].matchAll(/<(p|dd|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((x) => txt(x[2])).filter((t) => t.split(" ").length >= 6);
      const a = (paras.length ? paras.slice(0, 2).join(" ") : txt(m[3])).split(" ").slice(0, 120).join(" ");
      if (a.split(" ").length < 8) continue;
      seen.add(q.toLowerCase()); out.push({ q, a });
    }
    return out;
  } catch { return []; }
}

// ── Deterministic JSON-LD scaffolds (filled from context) ─────────────────────
// ── Business facts: the client's approved intake + the pinned Google Business
// Profile (Places API New) for coordinates, structured hours and rating.
// Without a pinned listing the street address is geocoded through Places.
type Facts = Record<string, any>;
async function businessFacts(client: any, ctx: any): Promise<Facts> {
  const iv: any = client?.intake || {};
  const list = (v: unknown) => String(v || "").split(/\s*[,\n;]\s*/).map((x) => x.trim()).filter(Boolean);
  const url = (v: unknown) => /^https?:\/\/\S+$/i.test(String(v || "").trim()) ? String(v).trim() : "";
  const origin = "https://" + String(client?.url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").split("/")[0];
  const f: Facts = {
    // The client's real name beats the audit context, which falls back to the
    // bare domain when the homepage couldn't be read.
    origin, name: String(iv.business_name || client?.name || ctx?.business_name || "").trim(),
    phone: String(iv.phone || "").trim(), email: String(iv.email || "").trim(),
    street: String(iv.street || "").trim(), city: String(iv.city || "").trim(), state: String(iv.state || "").trim(), zip: String(iv.zip || "").trim(),
    hours: String(iv.hours || "").trim(), description: String(iv.description || "").trim(),
    category: String(iv.category_primary || iv.categories || ctx?.business_type || "").trim(),
    services: list(iv.services).length ? list(iv.services) : (Array.isArray(ctx?.services) ? ctx.services.map(String) : []),
    products: list(iv.products), areas: list(iv.service_areas), languages: list(iv.languages),
    year: String(iv.year_established || "").trim(), payment: list(iv.payment_types),
    owner: String(iv.owner || "").trim(), credentials: String(iv.credentials || "").trim(),
    rating: String(iv.gbp_rating || "").trim(), reviews: String(iv.gbp_reviews || "").trim(),
    logo: url(iv.logo_url), image: url(iv.cover_image_url),
    sameAs: [iv.gbp, iv.facebook, iv.instagram, iv.linkedin, iv.x].map(url).filter(Boolean),
    market: String(client?.market || "").trim(),
  };
  const key = await platformKey("GOOGLE_PLACES_API_KEY").catch(() => "");
  if (key) {
    const H = (mask: string) => ({ "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask, "Content-Type": "application/json" });
    try {
      let p: any = null;
      if (client?.gbp_place_id) {
        const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(client.gbp_place_id)}`,
          { headers: H("location,regularOpeningHours,rating,userRatingCount,googleMapsUri,nationalPhoneNumber,addressComponents,displayName"), signal: AbortSignal.timeout(12_000) });
        if (r.ok) p = await r.json();
      } else if (f.street && f.city) {
        const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: H("places.location"),
          body: JSON.stringify({ textQuery: `${f.street}, ${f.city}, ${f.state} ${f.zip}`.trim(), pageSize: 1 }), signal: AbortSignal.timeout(12_000) });
        if (r.ok) p = ((await r.json())?.places || [])[0] || null;
      }
      if (p?.location?.latitude != null) { f.lat = Number(Number(p.location.latitude).toFixed(6)); f.lng = Number(Number(p.location.longitude).toFixed(6)); }
      const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const pad = (n: number) => String(n ?? 0).padStart(2, "0");
      const periods: any[] = p?.regularOpeningHours?.periods || [];
      if (periods.length) {
        const by = new Map<string, string[]>();
        periods.forEach((x: any) => {
          if (!x?.open || !x?.close) return;
          const k = `${pad(x.open.hour)}:${pad(x.open.minute)}-${pad(x.close.hour)}:${pad(x.close.minute)}`;
          if (!by.has(k)) by.set(k, []);
          by.get(k)!.push(DAY[x.open.day]);
        });
        f.hoursSpec = [...by.entries()].map(([k, days]) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: days, opens: k.split("-")[0], closes: k.split("-")[1] }));
      }
      if (!f.rating && p?.rating != null) f.rating = String(p.rating);
      if (!f.reviews && p?.userRatingCount != null) f.reviews = String(p.userRatingCount);
      if (!f.phone && p?.nationalPhoneNumber) f.phone = p.nationalPhoneNumber;
      // Address from the listing when the intake has none.
      const comp = (t: string, short = false) => { const c = (p?.addressComponents || []).find((x: any) => (x.types || []).includes(t)); return c ? String(short ? c.shortText : c.longText) : ""; };
      if (!f.street && comp("route")) f.street = [comp("street_number"), comp("route")].filter(Boolean).join(" ");
      if (!f.city && comp("locality")) f.city = comp("locality");
      if (!f.state && comp("administrative_area_level_1")) f.state = comp("administrative_area_level_1", true);
      if (!f.zip && comp("postal_code")) f.zip = comp("postal_code");
      if (!f.name && p?.displayName?.text) f.name = String(p.displayName.text);
      if (p?.googleMapsUri && !f.sameAs.some((u: string) => /google\.[a-z.]+\/(maps|search)|maps\.google|g\.page|goo\.gl/i.test(u))) f.sameAs.push(p.googleMapsUri);
    } catch { /* Places unavailable — facts from intake only */ }
  }
  return f;
}

// The most specific schema.org type for the business (Google recommends it).
function schemaTypeFor(cat: string): string {
  const c = String(cat || "").toLowerCase();
  const T: [RegExp, string][] = [
    [/roof/, "RoofingContractor"], [/plumb/, "Plumber"], [/electric(al|ian)/, "Electrician"],
    [/hvac|heating|air condition|furnace|cooling/, "HVACBusiness"], [/paint/, "HousePainter"], [/locksmith/, "Locksmith"],
    [/moving|movers/, "MovingCompany"], [/general contractor|construction|remodel|builder|masonry|paving|concrete|exterior|siding|deck|fenc/, "GeneralContractor"],
    [/landscap|lawn|tree|garage door|handyman|pest|clean/, "HomeAndConstructionBusiness"],
    [/dentist|dental|orthodont/, "Dentist"], [/attorney|law firm|lawyer|legal/, "Attorney"],
    [/dermatolog|aesthetic|med ?spa|medical|clinic|physician|doctor|surgery|sleep center|chiropract/, "MedicalClinic"],
    [/auto repair|mechanic|collision|body shop/, "AutoRepair"], [/car dealer|auto dealer/, "AutoDealer"],
    [/restaurant|grill|pizza|bbq|diner/, "Restaurant"], [/cafe|coffee/, "CafeOrCoffeeShop"], [/\bbar\b|pub|brewery/, "BarOrPub"],
    [/liquor|wine shop/, "LiquorStore"], [/furniture/, "FurnitureStore"], [/bike|e-bike|scooter/, "BikeStore"], [/hardware/, "HardwareStore"],
    [/floor|carpet|tile/, "HomeGoodsStore"], [/trailer|supply|store|shop|retail|dealer|supplier|nursery/, "Store"],
    [/insurance/, "InsuranceAgency"], [/real estate|realtor/, "RealEstateAgent"], [/accountant|accounting|cpa|bookkeep|tax/, "AccountingService"],
    [/salon|barber/, "HairSalon"], [/\bspa\b/, "DaySpa"], [/gym|fitness/, "ExerciseGym"], [/bowling/, "BowlingAlley"],
    [/consult|marketing|agency|analytics|software|it services|computer|technology|staffing|data/, "ProfessionalService"],
  ];
  for (const [re, t] of T) if (re.test(c)) return t;
  return "LocalBusiness";
}

function buildSchema(kind: string, a: { name: string; city: string; page: string; kw: string; facts: Facts }): { jsonld: any; missing: string[] } {
  const f: Facts = a.facts || {};
  const origin = f.origin || (() => { try { return new URL(a.page).origin; } catch { return a.page; } })();
  const name = f.name || a.name;
  const missing: string[] = [];
  const bizId = `${origin}/#business`;
  const services: string[] = f.services || [], products: string[] = f.products || [], areas: string[] = f.areas || [], sameAs: string[] = f.sameAs || [];
  const addr = (f.street || f.city) ? { "@type": "PostalAddress", ...(f.street ? { streetAddress: f.street } : {}),
    ...(f.city ? { addressLocality: f.city } : {}), ...(f.state ? { addressRegion: f.state } : {}), ...(f.zip ? { postalCode: f.zip } : {}), addressCountry: "US" } : null;
  const founder = f.owner ? { "@type": "Person", "@id": `${origin}/#owner`, name: String(f.owner).replace(/\s*[,(–—].*$/, "").trim() || f.owner,
    ...(f.credentials ? { description: f.credentials } : {}), worksFor: { "@id": bizId } } : null;
  const areaServed = (areas.length ? areas : (f.city ? [f.city] : (a.city ? [a.city] : []))).slice(0, 12).map((x: string) => ({ "@type": "City", name: x }));
  const offers = [
    ...services.slice(0, 12).map((x: string) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name: x, provider: { "@id": bizId }, ...(areaServed.length ? { areaServed } : {}) } })),
    ...products.slice(0, 12).map((x: string) => ({ "@type": "Offer", itemOffered: { "@type": "Product", name: x } })),
  ];
  const rating = f.rating && f.reviews && Number(f.reviews) > 0
    ? { "@type": "AggregateRating", ratingValue: String(f.rating), reviewCount: String(f.reviews), bestRating: "5" } : null;
  switch (kind) {
    case "local_business_schema": {
      if (!name) missing.push("business name");
      if (!addr) missing.push("address (street/city)");
      if (!f.phone) missing.push("phone");
      if (!name) return { jsonld: null, missing };
      const j: any = { "@context": "https://schema.org", "@type": schemaTypeFor(f.category), "@id": bizId, name, url: origin };
      if (f.description) j.description = String(f.description).slice(0, 500);
      if (f.phone) j.telephone = f.phone;
      if (f.email) j.email = f.email;
      if (addr) j.address = addr;
      if (f.lat != null) j.geo = { "@type": "GeoCoordinates", latitude: f.lat, longitude: f.lng }; else missing.push("coordinates (pin the Business Profile or add a street address)");
      if (f.hoursSpec?.length) j.openingHoursSpecification = f.hoursSpec;
      else if (/^(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]?([-,](Mo|Tu|We|Th|Fr|Sa|Su)[a-z]?)*\s+\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(f.hours || "")) j.openingHours = String(f.hours).split(/\s*;\s*/);
      else missing.push("hours");
      if (areaServed.length) j.areaServed = areaServed;
      if (f.logo) j.logo = f.logo;
      if (f.image || f.logo) j.image = f.image || f.logo;
      if (sameAs.length) j.sameAs = sameAs;
      if (founder) j.founder = founder;
      if (f.year && /^\d{4}$/.test(f.year)) j.foundingDate = f.year;
      if (f.languages?.length) j.knowsLanguage = f.languages;
      if (f.payment?.length) j.paymentAccepted = f.payment.join(", ");
      if (offers.length) j.hasOfferCatalog = { "@type": "OfferCatalog", name: "Services", itemListElement: offers };
      if (rating) j.aggregateRating = rating;
      return { jsonld: j, missing };
    }
    case "org_schema": {
      if (!name) return { jsonld: null, missing: ["business name"] };
      const j: any = { "@context": "https://schema.org", "@type": "Organization", "@id": `${origin}/#organization`, name, url: origin };
      if (f.logo) j.logo = f.logo; else missing.push("logo URL");
      if (sameAs.length) j.sameAs = sameAs; else missing.push("social / GBP profile links");
      if (founder) j.founder = founder;
      if (f.phone) j.contactPoint = { "@type": "ContactPoint", telephone: f.phone, contactType: "customer service" };
      return { jsonld: j, missing };
    }
    case "person_schema": {
      if (!founder) return { jsonld: null, missing: ["owner / public contact"] };
      const j: any = { "@context": "https://schema.org", ...founder, worksFor: { "@type": "Organization", "@id": bizId, name } };
      const li = sameAs.find((u: string) => /linkedin\.com\/in\//i.test(u)); if (li) j.sameAs = [li];
      const topics = [...services.slice(0, 6), ...(a.kw ? [a.kw] : [])]; if (topics.length) j.knowsAbout = topics;
      return { jsonld: j, missing };
    }
    case "breadcrumb_schema": {
      let path: string[] = [];
      try { path = new URL(a.page).pathname.split("/").filter(Boolean); } catch { /* bad url */ }
      const nice = (seg: string) => decodeURIComponent(seg).replace(/[-_]+/g, " ").replace(/\.\w+$/, "").replace(/\b\w/g, (c) => c.toUpperCase());
      const items = [{ "@type": "ListItem", position: 1, name: "Home", item: origin + "/" },
        ...path.map((seg, i) => ({ "@type": "ListItem", position: i + 2, name: nice(seg), item: `${origin}/${path.slice(0, i + 1).join("/")}/` }))];
      return { jsonld: { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items }, missing };
    }
    case "aggregate_rating_schema":
      if (!rating) return { jsonld: null, missing: ["Google rating + review count"] };
      return { jsonld: { "@context": "https://schema.org", "@type": schemaTypeFor(f.category), "@id": bizId, name, url: origin, aggregateRating: rating }, missing };
    case "website_schema":
      return { jsonld: { "@context": "https://schema.org", "@type": "WebSite", "@id": `${origin}/#website`, name, url: origin, publisher: { "@id": bizId },
        potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${origin}/?s={search_term_string}` }, "query-input": "required name=search_term_string" } }, missing };
    default:
      return { jsonld: { "@context": "https://schema.org", "@type": "Thing", name }, missing };
  }
}

// ── llms.txt + llms-full.txt from facts and the audited pages ────────────────
async function buildLlms(f: Facts, auditId: string, supa: any): Promise<{ llms: string; full: string; pages: number }> {
  let pages: any[] = [];
  try {
    const { data } = await supa.from("audits").select("raw").eq("id", auditId).maybeSingle();
    pages = ((data?.raw?.pages || []) as any[]).filter((p) => p && p.ok !== false && p.url && !/\.(xml|json|txt|pdf)(\?|$)/i.test(p.url));
  } catch { /* no page list */ }
  const seen = new Set<string>();
  pages = pages.filter((p) => { const k = String(p.url).replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
  if (!pages.length) pages = [{ url: f.origin + "/", title: f.name }];
  const clean = (t: unknown) => String(t || "").replace(/\s+/g, " ").trim();
  const title = (p: any) => clean(p.title).split(/\s[|–—-]\s/)[0] || clean(p.url).replace(/^https?:\/\/[^/]+/, "") || "Page";
  const services: string[] = f.services || [], products: string[] = f.products || [], areas: string[] = f.areas || [], sameAs: string[] = f.sameAs || [];
  const where = [f.city, f.state].filter(Boolean).join(", ") || f.market;
  const L: string[] = [`# ${f.name || f.origin}`, ""];
  L.push(`> ${f.description ? clean(f.description).slice(0, 400) : `${f.name} is a ${f.category || "local business"}${where ? ` serving ${where}` : ""}.`}`, "");
  const factsList = [
    f.category && `Business type: ${f.category}`, where && `Location: ${[f.street, where, f.zip].filter(Boolean).join(", ")}`,
    areas.length && `Service area: ${areas.join(", ")}`, f.phone && `Phone: ${f.phone}`, f.email && `Email: ${f.email}`,
    f.hours && `Hours: ${f.hours}`, f.year && `Established: ${f.year}`, f.owner && `Owner: ${f.owner}`,
    f.credentials && `Credentials: ${clean(f.credentials)}`, f.rating && f.reviews && `Google rating: ${f.rating} (${f.reviews} reviews)`,
  ].filter(Boolean) as string[];
  if (factsList.length) L.push("## Key facts", "", ...factsList.map((x) => `- ${x}`), "");
  if (services.length) L.push("## Services", "", ...services.map((x) => `- ${x}`), "");
  if (products.length) L.push("## Products", "", ...products.map((x) => `- ${x}`), "");
  L.push("## Key pages", "", ...pages.map((p) => `- [${title(p)}](${p.url})${clean(p.metaDesc) ? `: ${clean(p.metaDesc).slice(0, 160)}` : ""}`), "");
  if (sameAs.length) L.push("## Profiles", "", ...sameAs.map((u) => `- ${u}`), "");
  L.push("## Optional", "", `- [Full site text for AI tools](${f.origin}/llms-full.txt)`, "");
  const llms = L.join("\n");
  // llms-full.txt: the same header + every key page's readable text.
  const toMd = (html: string) => html
    .replace(/<(script|style|noscript|svg|template|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m: string, n: string, t: string) => `\n\n${"#".repeat(Math.min(6, Math.max(3, Number(n) + 1)))} ${clean(t.replace(/<[^>]+>/g, ""))}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, t: string) => `\n- ${clean(t.replace(/<[^>]+>/g, ""))}`)
    .replace(/<(p|div|section|article|br|tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&[a-z]+;/gi, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const bodies = await Promise.all(pages.slice(0, 25).map(async (p) => {
    try {
      const r = await fetch(p.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; 44i-llms/1.0)" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok || !/html/i.test(r.headers.get("content-type") || "")) return "";
      const html = await r.text();
      const main = (html.match(/<main\b[\s\S]*?<\/main>/i) || html.match(/<article\b[\s\S]*?<\/article>/i) || html.match(/<body\b[\s\S]*?<\/body>/i) || [html])[0];
      const md = toMd(main).slice(0, 12_000);
      return md.split(/\s+/).length > 40 ? `## ${title(p)}\n\nURL: ${p.url}\n\n${md}` : "";
    } catch { return ""; }
  }));
  const kept = bodies.filter(Boolean);
  const full = [llms.replace(/\n## Optional[\s\S]*$/, "").trim(), "", "---", "", kept.join("\n\n---\n\n")].join("\n").slice(0, 400_000);
  return { llms, full, pages: kept.length };
}

// ── Deterministic deployable files/snippets (v4 directive engine) ─────────────
function buildFileArtifact(kind: string, a: { name: string; city: string; page: string; ctx: any }): string {
  const origin = (() => { try { return new URL(a.page).origin; } catch { return a.page; } })();
  const host = origin.replace(/^https?:\/\//, "");
  switch (kind) {
    case "robots_txt":
      return [
        "# robots.txt — deploy at the site root",
        "User-agent: *",
        "Allow: /",
        "",
        "# AI search & answer engines: they fetch pages to cite them in",
        "# ChatGPT search, Perplexity and Claude answers.",
        "User-agent: OAI-SearchBot",
        "User-agent: ChatGPT-User",
        "User-agent: PerplexityBot",
        "User-agent: Perplexity-User",
        "User-agent: Claude-SearchBot",
        "User-agent: Claude-User",
        "Allow: /",
        "",
        "# AI training crawlers. Delete this group to opt out of model training;",
        "# citations in AI answers are unaffected either way.",
        "User-agent: GPTBot",
        "User-agent: Google-Extended",
        "User-agent: ClaudeBot",
        "User-agent: Applebot-Extended",
        "Allow: /",
        "",
        `Sitemap: ${a.ctx.sitemap_url || `${origin}/sitemap.xml`}`,
        "",
      ].join("\n");
    case "sitemap_xml": {
      const urls: string[] = (a.ctx.pages || [a.page]).slice(0, 50);
      const today = new Date().toISOString().slice(0, 10);
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
        `\n</urlset>\n\nDeploy at ${origin}/sitemap.xml (or enable the CMS/SEO-plugin sitemap), then submit in Search Console. On WordPress prefer the plugin-generated sitemap — this file is the fallback.`;
    }
    case "canonical":
      return `<link rel="canonical" href="${a.page}" />\n\nAdd to <head>. Every indexable page needs its own self-referencing canonical (page builders/SEO plugins can template this as the page's own URL).`;
    case "security_headers": {
      const missing: string[] = a.ctx.missing || ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options/frame-ancestors", "Referrer-Policy"];
      const rules: Record<string, [string, string]> = {
        "Strict-Transport-Security": [`Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"`, `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`],
        "X-Content-Type-Options": [`Header always set X-Content-Type-Options "nosniff"`, `add_header X-Content-Type-Options "nosniff" always;`],
        "X-Frame-Options/frame-ancestors": [`Header always set X-Frame-Options "SAMEORIGIN"`, `add_header X-Frame-Options "SAMEORIGIN" always;`],
        "Referrer-Policy": [`Header always set Referrer-Policy "strict-origin-when-cross-origin"`, `add_header Referrer-Policy "strict-origin-when-cross-origin" always;`],
      };
      const rows = missing.filter((m) => rules[m]);
      return `# Apache (.htaccess) — add inside <IfModule mod_headers.c>\n${rows.map((m) => rules[m][0]).join("\n")}\n\n# nginx (server block)\n${rows.map((m) => rules[m][1]).join("\n")}\n\nDeploy via hosting config or a security plugin, then re-audit to verify.`;
    }
    case "redirect_map": {
      const alt = a.ctx.alt_host || (host.startsWith("www.") ? host.replace(/^www\./, "") : `www.${host}`);
      const parts: string[] = [];
      if (a.ctx.https_redirect === false) parts.push(
        `# Force HTTPS (Apache .htaccess)\nRewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]`);
      if (a.ctx.host_canonical === false) parts.push(
        `# Canonical host: 301 ${alt} → ${host}\nRewriteCond %{HTTP_HOST} ^${alt.replace(/\./g, "\\.")}$ [NC]\nRewriteRule ^(.*)$ ${origin}/$1 [L,R=301]`);
      if (a.ctx.from_crawl) parts.push(
        `# Broken URLs (4XX) from the crawl: export the 4XX list from the site-audit\n# project and add one rule per URL, pointing at the closest live page:\n# Redirect 301 /old-page/ ${origin}/replacement-page/`);
      if (!parts.length) parts.push(`# 301 redirect map — no automatic rules derived; map each broken URL to its closest live equivalent:\n# Redirect 301 /old-url/ ${origin}/new-url/`);
      return parts.join("\n\n");
    }
    case "favicon":
      return [
        `Add these to <head> (files at the site root):`,
        `<link rel="icon" href="${origin}/favicon.ico" sizes="32x32">`,
        `<link rel="icon" href="${origin}/icon.svg" type="image/svg+xml">`,
        `<link rel="apple-touch-icon" href="${origin}/apple-touch-icon.png">`,
        ``,
        `Export the ${a.name} logo mark as a 512×512 PNG; generate sizes with a favicon generator. Google shows the favicon next to the brand in mobile SERPs.`,
      ].join("\n");
    default:
      return "";
  }
}

// Convert the AI 'Q:/A:' block into FAQPage JSON-LD.
function faqToJsonLd(text: string) {
  const items: any[] = [];
  const re = /Q:\s*([\s\S]*?)\s*A:\s*([\s\S]*?)(?=(?:\n\s*Q:)|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const q = m[1].replace(/\s+/g, " ").trim(); const ans = m[2].replace(/\s+/g, " ").trim();
    if (q && ans) items.push({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: ans } });
  }
  return items.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items } : null;
}

// Fetch a page and return short descriptors for <img> tags missing alt text.
async function imagesMissingAlt(url: string): Promise<string[]> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; 44i/1.0)" } });
    clearTimeout(t);
    if (!r.ok) return [];
    const html = await r.text();
    const out: string[] = [];
    const re = /<img\b[^>]*>/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 20) {
      const tag = m[0];
      if (/\balt\s*=\s*["'][^"']*\S[^"']*["']/i.test(tag)) continue; // already has non-empty alt
      const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || "(no src)";
      out.push(src.split("/").pop() || src);
    }
    return out;
  } catch { return []; }
}
