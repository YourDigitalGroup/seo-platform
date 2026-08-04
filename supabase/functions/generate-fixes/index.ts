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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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

  // The AI writer key (secret name unchanged so the deployed config keeps working).
  const AI_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  try {
    const body = await req.json().catch(() => ({}));
    const ids: string[] = body.fix_ids ?? (body.fix_id ? [body.fix_id] : []);
    const instruction: string | null = body.instruction ?? null;
    const editor_id: string | null = body.editor_id ?? null;
    if (!ids.length) return json({ error: "fix_ids (or fix_id) required" }, 400);

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
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) throw new Error(`AI writer ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    };

    const results: any[] = [];
    for (const id of ids) {
      // Load the fix + its client (via the audit) for naming/locale context.
      const { data: fix, error: fErr } = await supa.from("fixes").select("*").eq("id", id).single();
      if (fErr || !fix) { results.push({ id, error: "fix not found" }); continue; }
      const { data: audit } = await supa.from("audits").select("client_id").eq("id", fix.audit_id).single();
      const { data: client } = audit
        ? await supa.from("clients").select("url, market").eq("id", audit.client_id).single()
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
          schema_jsonld = buildSchema(kind, { name, city, page, kw });
          after_text = "<script type=\"application/ld+json\">\n" +
            JSON.stringify(schema_jsonld, null, 2) + "\n</script>";

        } else if (FILE_KINDS.has(kind)) {
          // ── Deterministic deployable files/snippets (v4; no AI) ───────────────
          after_text = buildFileArtifact(kind, { name, city, page, ctx });

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
          const model = MODEL_FOR[kind] || MODEL_FOR._default; usedModel = model;
          const { system, user, max } = promptFor(kind, { name, city, kw, page, before: fix.before_text || "", instruction });
          after_text = await writeAI(model, PROVENANCE + system, user, max);
          if (kind === "faq_schema") schema_jsonld = faqToJsonLd(after_text);
        }

        const update: Record<string, unknown> = {
          after_text, schema_jsonld, status: "ready", updated_at: new Date().toISOString(),
          revision: (fix.revision || 1) + (instruction ? 1 : 0),
        };
        if (usedModel) update.model = MODEL_ENUM[usedModel] ?? null;
        if (instruction) update.last_instruction = instruction;
        if (editor_id) update.edited_by = editor_id;
        await supa.from("fixes").update(update).eq("id", id);
        results.push({ id, kind, status: "ready" });
      } catch (e) {
        await supa.from("fixes").update({ status: "suggested" }).eq("id", id); // leave re-runnable
        results.push({ id, kind, error: String(e) });
      }
    }
    return json({ ok: true, results });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e) }, 500);
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
      return { max: 900, system: "You write FAQ content for answer-engine optimization. Return 5–6 question/answer pairs. Each answer is 2–4 declarative sentences. Format exactly as 'Q: ...' then 'A: ...' lines.",
        user: `Business: ${a.name}${loc}. Topic/keyword: "${a.kw}". Write FAQs real customers ask, with direct answers.${tail}` };
    case "internal_link":
      return { max: 600, system: "You produce an internal-linking plan: for each suggested anchor text, give the source page idea and target page. Output a concise list.",
        user: `Business: ${a.name}${loc}. Keyword theme: "${a.kw}". Suggest 5 internal links that strengthen topical relevance and funnel toward conversion pages.${tail}` };
    case "gbp_post":
      return { max: 350, system: "You write Google Business Profile posts. STRICT SHAPE: 100-300 words of plain text, no headings, no lists, no markdown, exactly one call to action. Never an article. Output only the post.",
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

// ── Deterministic JSON-LD scaffolds (filled from context) ─────────────────────
function buildSchema(kind: string, a: { name: string; city: string; page: string; kw: string }) {
  const origin = (() => { try { return new URL(a.page).origin; } catch { return a.page; } })();
  switch (kind) {
    case "local_business_schema":
      // Stable @id so Service/blog schema on other pages can reference this
      // entity instead of re-declaring it.
      return { "@context": "https://schema.org", "@type": "LocalBusiness", "@id": `${origin}/#business`, name: a.name, url: origin,
        address: { "@type": "PostalAddress", addressLocality: a.city || "[CITY]", addressRegion: "[STATE]", postalCode: "[ZIP]", streetAddress: "[STREET]" },
        geo: { "@type": "GeoCoordinates", latitude: "[LAT]", longitude: "[LNG]" },
        openingHours: "[e.g. Mo-Fr 08:00-17:00]",
        telephone: "[PHONE]", areaServed: a.city || "[CITY]", image: `${origin}/[IMAGE]`,
        sameAs: ["[GBP_URL]", "[FACEBOOK_URL]", "[LINKEDIN_URL]"] };
    case "org_schema":
      return { "@context": "https://schema.org", "@type": "Organization", name: a.name, url: origin,
        logo: `${origin}/[LOGO]`, sameAs: ["[FACEBOOK_URL]", "[INSTAGRAM_URL]", "[LINKEDIN_URL]"] };
    case "person_schema":
      return { "@context": "https://schema.org", "@type": "Person", name: "[FULL NAME]", jobTitle: "[TITLE]",
        worksFor: { "@type": "Organization", name: a.name }, url: a.page,
        sameAs: ["[PROFILE_URL_1]", "[PROFILE_URL_2]"], knowsAbout: a.kw ? [a.kw] : ["[EXPERTISE]"] };
    case "breadcrumb_schema":
      return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: origin },
        { "@type": "ListItem", position: 2, name: "[SECTION]", item: `${origin}/[section]` },
        { "@type": "ListItem", position: 3, name: "[PAGE]", item: a.page } ] };
    case "aggregate_rating_schema":
      return { "@context": "https://schema.org", "@type": "LocalBusiness", name: a.name, url: origin,
        aggregateRating: { "@type": "AggregateRating", ratingValue: "[AVG e.g. 4.9]", reviewCount: "[COUNT]", bestRating: "5" } };
    case "website_schema":
      return { "@context": "https://schema.org", "@type": "WebSite", name: a.name, url: origin,
        potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${origin}/?s={search_term_string}` }, "query-input": "required name=search_term_string" } };
    default:
      return { "@context": "https://schema.org", "@type": "Thing", name: a.name };
  }
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
