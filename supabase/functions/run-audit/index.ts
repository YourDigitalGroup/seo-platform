// ============================================================================
//  44i SEO/AEO Delivery System — run-audit Edge Function  (v4)
// ----------------------------------------------------------------------------
//  v4 — THE DIRECTIVE ENGINE. Three structural upgrades on top of v3:
//
//    A. EXHAUSTIVE CHECKLIST — every pillar score is now a weighted pass-rate
//       over ~55 deterministic checks: the union of what Lighthouse/PageSpeed,
//       Ahrefs, SEMrush, Moz and the popular "SEO checker" tools grade
//       (HTTPS + redirect chains, host canonicalization, robots/sitemap
//       validity, soft-404s, security headers, mixed content, Core Web Vitals,
//       duplicate titles/metas, OG/Twitter cards, canonical self-reference,
//       favicon, lang/charset, llms.txt, entity sameAs, trust pages, NAP/GBP
//       signals, …). A green checklist IS a top third-party score by
//       construction — no external auditor tests something we don't.
//    B. PLAN-SCOPED DIRECTIVE — every failed check maps to a fix kind and to
//       a service in the client's plan (service_templates). In-plan work is
//       auto-staged; out-of-plan items become explicit upgrade
//       recommendations with the tier that unlocks them. Stored on
//       packages.directive (+ audits.raw.directive fallback).
//    C. VERIFICATION LOOP — each re-audit re-evaluates the same checklist,
//       flips pushed fixes to "verified" when their check passes, reports
//       fixed/regressed checks, and tracks the composite 0-100 score toward
//       the 90+ target. New pillar: PERFORMANCE (PageSpeed API, key optional
//       via PAGESPEED_API_KEY secret; graceful TTFB fallback).
//
//  v3 depth upgrades below are unchanged, each with graceful fallback so it
//  always returns a complete audit:
//
//    1. FULL-SITE CRAWL  — when a crawl project exists for the domain (matched
//       by stored id OR auto-discovered by URL), every crawled page is audited
//       (title/meta/H1/words/images/schema), the real site health score drives
//       the technical grade, and crawl issues become findings. Fallback: fetch
//       and parse the homepage + top trafficked pages.
//
//    2. AI-CITATION AEO  — pulls share-of-voice and mention counts across AI
//       assistants (ChatGPT, AI Overviews, Perplexity, Gemini) for the brand
//       vs its competitors. Works with a configured brand report OR directly
//       from the brand name. Fallback: SERP-feature capture + answer-readiness.
//
//    3. SERP-DERIVED LOCAL COMPETITORS — runs a "[service] [city]" SERP lookup
//       and reads who actually ranks (incl. the local pack), instead of relying
//       on national keyword-overlap competitors. Fallback: filtered organic
//       competitors.
//
//  Data sources: search-intelligence API (authority, keywords w/ SERP features,
//  competitors, pages, crawl, brand radar, SERP), direct page fetch (E-E-A-T /
//  NAP body-text signals), and Google Search Console (real clicks/positions).
//
//  Deploy: Edge Functions → run-audit → redeploy.  Secret: AHREFS_API_KEY.
//  Input: { "client_id": "<uuid>" }.  No migration required.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// ── Tuning knobs ─────────────────────────────────────────────────────────────
const KW_LIMIT         = 30;   // client organic keywords pulled
const GAP_SOURCE_LIMIT = 25;   // competitor keywords scanned for the gap diff
const GAP_KEEP         = 12;   // gaps written
const COMP_FETCH       = 8;    // organic competitors fetched (pre-filter)
const COMP_KEEP        = 6;    // competitors kept after filter+merge
const COMP_PAGES_FROM  = 2;    // competitors to pull winning pages for
const COMP_PAGES_EACH  = 5;
const CLIENT_PAGES     = 10;   // client top pages pulled
const FETCH_PAGES      = 4;    // pages fetched in FALLBACK (no crawl) mode
const CRAWL_PAGE_LIMIT = 100;  // pages pulled from a crawl project
const FIX_PAGE_CAP     = 20;   // pages individually staged for fixes (keeps review sane)
const SERP_TOP         = 10;   // SERP positions read for local competitors
const SITEMAP_CRAWL    = 25;   // pages fetched in the LIGHTWEIGHT sitemap crawl (no crawl project)
const LINKGAP_LIMIT    = 50;   // competitor referring domains scanned for the link gap
const LINKGAP_KEEP     = 15;   // link/citation opportunities kept
const COUNTRY          = "us";
// Which AI assistants to measure brand presence across.
const AI_SOURCES       = "chatgpt,google_ai_overviews,perplexity,gemini";

const PLATFORM_DENYLIST = [
  "wikipedia.org","facebook.com","instagram.com","youtube.com","x.com","twitter.com",
  "linkedin.com","pinterest.com","reddit.com","yelp.com","tripadvisor.com","amazon.com",
  "ticketmaster.com","eventbrite.com","bandsintown.com","songkick.com","google.com",
  "apple.com","spotify.com","mapquest.com","yellowpages.com","bbb.org","indeed.com",
  "maps.google.com","g.co","goo.gl",
];
const EXPECT_SCHEMA = ["Organization","LocalBusiness","FAQPage","BreadcrumbList","AggregateRating"];

const AHREFS = "https://api.ahrefs.com/v3";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const grade = (n: number) => n >= 90 ? "A" : n >= 78 ? "B" : n >= 65 ? "C" : n >= 50 ? "D" : "F";
const rootOf = (d: string) => String(d || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
// ── KEYWORD VALIDATION GATE (code, not prompt — a filter can't be talked out
//    of rejecting "ia"). junkKw() screens research pools; validTarget() is the
//    stricter gate a keyword must pass before ANY content is generated for it.
const US_STATES = new Set(("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc " +
  "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada newhampshire newjersey newmexico newyork northcarolina northdakota ohio oklahoma oregon pennsylvania rhodeisland southcarolina southdakota tennessee texas utah vermont virginia washington westvirginia wisconsin wyoming").split(" "));
const junkKw = (k: unknown) => { const t = String(k || "").trim().toLowerCase(); return t.length < 4 || /^[a-z]{2}\.?$/.test(t) || US_STATES.has(t.replace(/\s+/g, "")); };
// Reject as a CONTENT TARGET: junk fragments, bare locations, single tokens,
// ZIP codes, and near-me phrases (near-me intent is served by GBP, not pages).
const targetRejectReason = (k: unknown, geos: string[] = []): string | null => {
  const t = String(k || "").trim().toLowerCase();
  if (junkKw(t)) return "junk fragment / bare state";
  if (/^\d{5}(-\d{4})?$/.test(t)) return "bare ZIP code";
  if (t.split(/\s+/).length < 2) return "single word — too ambiguous to target";
  if (/\bnear me\b/.test(t)) return "near-me query — served by GBP, not an on-page target";
  const bare = t.replace(/,?\s*[a-z]{2}$/, "").trim();
  if (geos.some((g) => { const town = String(g).split(",")[0].trim().toLowerCase(); return town && (bare === town || t === town); })) return "bare location name";
  return null;
};
// ── KEYWORD IDENTITY (round-2 rule 6.2): two keywords are the same keyword if
//    they normalize to the same string OR one's token set contains the other's
//    (same head terms + geography = same search intent = one page).
const KW_FILLERS = new Set(["and", "the", "a", "an", "in", "for", "of", "services", "service", "solutions", "company", "provider", "llc", "inc"]);
const kwTokens = (k: unknown): string[] =>
  String(k || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((t) => t && !KW_FILLERS.has(t));
const kwKey = (k: unknown): string => [...new Set(kwTokens(k))].sort().join(" ");
const sameIntent = (keyA: string, keyB: string): boolean => {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  const A = keyA.split(" "), B = keyB.split(" ");
  const [small, big] = A.length <= B.length ? [A, new Set(B)] : [B, new Set(A)];
  return small.every((t) => big.has(t));   // subset ⇒ "network support cedar rapids" ≡ "network support and management cedar rapids"
};

// ── HTML parsing helpers (fallback page fetch; no DOM in Deno) ────────────────
function getTitle(html: string){ const m=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m?m[1].replace(/\s+/g," ").trim():""; }
function getMeta(html: string, name: string){ const re=new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`,"i"); const t=html.match(re)?.[0]??""; return t.match(/content=["']([\s\S]*?)["']/i)?.[1]?.trim()??""; }
function countMatches(html: string, re: RegExp){ return (html.match(re)||[]).length; }
function wordCount(html: string){ const t=html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&[a-z]+;/gi," "); return (t.match(/\b[\w'-]+\b/g)||[]).length; }
function jsonLdTypes(html: string){ const types=new Set<string>(); const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m:RegExpExecArray|null;
  const collect=(o:any)=>{ if(!o||typeof o!=="object")return; if(Array.isArray(o))return o.forEach(collect); if(o["@type"])([] as any[]).concat(o["@type"]).forEach(t=>types.add(String(t))); if(o["@graph"])collect(o["@graph"]); for(const k of Object.keys(o)) if(typeof o[k]==="object")collect(o[k]); };
  while((m=re.exec(html))){ try{ collect(JSON.parse(m[1].trim())); }catch{ /* skip */ } } return [...types]; }
function getOrgName(html: string){ const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m:RegExpExecArray|null; let found="";
  const scan=(o:any)=>{ if(!o||typeof o!=="object"||found)return; if(Array.isArray(o))return o.forEach(scan); const t=([] as any[]).concat(o["@type"]||[]).map(String); if((t.includes("Organization")||t.includes("LocalBusiness"))&&o.name){found=String(o.name);return;} if(o["@graph"])scan(o["@graph"]); for(const k of Object.keys(o)) if(typeof o[k]==="object")scan(o[k]); };
  while((m=re.exec(html))&&!found){ try{ scan(JSON.parse(m[1].trim())); }catch{ /* skip */ } } return found; }
function answerSignals(html: string, types: string[]){ return { hasFAQSchema: types.includes("FAQPage"), questionHeadings: countMatches(html, /<h[2-4][^>]*>[^<]*\?\s*<\/h[2-4]>/gi) }; }
function napSignals(html: string, types: string[]){ const text=html.replace(/<[^>]+>/g," "); const hasPhone=/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text); const hasAddressSchema=types.includes("PostalAddress")||types.includes("LocalBusiness"); const hasZip=/\b\d{5}(?:-\d{4})?\b/.test(html.replace(/<script[\s\S]*?<\/script>/gi," ")); return { hasPhone, hasAddress: hasAddressSchema||hasZip }; }
function eeatSignals(html: string, types: string[]){ const text=html.toLowerCase(); return { hasPerson: types.includes("Person"), hasReviews: types.includes("Review")||types.includes("AggregateRating"), hasAbout: /about (us|our)|our team|meet the|our story|founded/.test(text), hasCredentials: /certified|licensed|award|years of experience|accredited|board[- ]certified/.test(text) }; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const errors: string[] = [];
  const note: string[] = [];   // human-readable notes about which sources were used

  try {
    const { client_id } = await req.json().catch(() => ({}));
    if (!client_id) return json({ error: "client_id is required" }, 400);
    const AHREFS_KEY = Deno.env.get("AHREFS_API_KEY");
    if (!AHREFS_KEY) return json({ error: "AHREFS_API_KEY is not set" }, 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // select * so contract columns (service_catalog.sql) are picked up when present
    // without breaking against a database that hasn't run that migration yet
    const { data: client, error: cErr } = await supa.from("clients")
      .select("*").eq("id", client_id).single();
    if (cErr || !client) return json({ error: "client not found", detail: cErr?.message }, 404);
    const target = String(client.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!target) return json({ error: "client has no URL" }, 400);
    const root = target.replace(/^www\./, "");
    const home = `https://${target}/`;
    const today = new Date().toISOString().slice(0, 10);

    // Defensive GET against the search-intelligence API.
    const ah = async (path: string, params: Record<string, string>) => {
      try {
        const r = await fetch(`${AHREFS}/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${AHREFS_KEY}`, Accept: "application/json" } });
        if (!r.ok) { errors.push(`${path} ${r.status}: ${(await r.text()).slice(0,160)}`); return null; }
        return await r.json();
      } catch (e) { errors.push(`${path}: ${String(e)}`); return null; }
    };
    // Defensive page fetch with parsing.
    const fetchPage = async (url: string) => {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; 44i-audit/1.0)" } });
        const html = r.ok ? await r.text() : ""; const types = html ? jsonLdTypes(html) : [];
        const title = getTitle(html), meta = getMeta(html, "description");
        return { url, status: r.status, ok: r.ok, https: url.startsWith("https://"), title, titleLen: title.length,
          metaDesc: meta, metaLen: meta.length, h1: countMatches(html, /<h1[\s>]/gi), words: wordCount(html),
          imgs: countMatches(html, /<img\b/gi), imgsNoAlt: countMatches(html, /<img\b(?![^>]*\balt\s*=)[^>]*>/gi),
          orgName: getOrgName(html), canonical: /<link[^>]+rel=["']canonical["']/i.test(html),
          viewport: /<meta[^>]+name=["']viewport["']/i.test(html), og: /<meta[^>]+property=["']og:/i.test(html),
          schemaTypes: types, aeo: answerSignals(html, types), nap: napSignals(html, types), eeat: eeatSignals(html, types) } as any;
      } catch (e) { return { url, status: 0, ok: false, error: String(e), schemaTypes: [] as string[] } as any; }
      finally { clearTimeout(timer); }
    };

    // ── 1. AUTHORITY / OVERVIEW ───────────────────────────────────────────────
    const dr  = await ah("site-explorer/domain-rating",   { target, date: today });
    const met = await ah("site-explorer/metrics",         { target, date: today, mode: "subdomains" });
    const bl  = await ah("site-explorer/backlinks-stats", { target, date: today, mode: "subdomains" });
    const domain_rating = dr?.domain_rating?.domain_rating ?? null;
    const Mx = met?.metrics ?? {};
    const org_keywords = Mx.org_keywords ?? null, org_keywords_top3 = Mx.org_keywords_1_3 ?? null, org_traffic = Mx.org_traffic ?? null;
    const live_backlinks = bl?.metrics?.live ?? null, referring_domains = bl?.metrics?.live_refdomains ?? null;

    // ── 2. CLIENT ORGANIC KEYWORDS (with SERP-feature / AI-Overview signals) ──
    const okw = await ah("site-explorer/organic-keywords", { target, date: today, country: COUNTRY, mode: "subdomains", limit: String(KW_LIMIT), order_by: "sum_traffic:desc",
      select: "keyword,best_position,best_position_kind,volume,sum_traffic,serp_features,is_local,is_commercial,is_informational,is_transactional,is_branded" });
    const ownKw = (okw?.keywords ?? []).filter((k: any) => k?.keyword);
    const ownKwSet = new Set(ownKw.map((k: any) => String(k.keyword).toLowerCase()));
    const ownKwPos: Record<string, number> = {}; ownKw.forEach((k: any) => { ownKwPos[String(k.keyword).toLowerCase()] = k.best_position; });
    const sf = (k: any) => ([] as string[]).concat(k.serp_features || []);
    const aiOverviewKws = ownKw.filter((k: any) => sf(k).some((f) => f.startsWith("ai_overview")));
    const aiCaptured    = ownKw.filter((k: any) => String(k.best_position_kind || "").startsWith("ai_overview"));
    const snippetKws    = ownKw.filter((k: any) => sf(k).includes("snippet"));
    const snippetWon    = ownKw.filter((k: any) => k.best_position_kind === "snippet");
    const paaKws        = ownKw.filter((k: any) => sf(k).includes("question"));
    const localPackKws  = ownKw.filter((k: any) => sf(k).includes("local_pack"));
    const localPackWon  = ownKw.filter((k: any) => k.best_position_kind === "local_pack");
    const localIntentKws= ownKw.filter((k: any) => k.is_local);
    const oppKws        = ownKw.filter((k: any) => k.best_position != null && k.best_position >= 4 && k.best_position <= 20);

    // ── 3. BUSINESS TYPE → KEYWORDS → KEYWORD-RELEVANT COMPETITORS ────────────
    // The audit must understand the business BEFORE choosing competitors, or it
    // grabs unrelated local sites. Order: (a) classify the business from its own
    // homepage, (b) research the keywords it should win, (c) find competitors
    // that actually rank for those keywords.
    const AI_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const writeAI = async (system: string, user: string, max = 500): Promise<string> => {
      if (!AI_KEY) return "";
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
          headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: max, system, messages: [{ role: "user", content: user }] }) });
        if (!r.ok) { errors.push(`classify ${r.status}`); return ""; }
        const d = await r.json(); return (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      } catch (e) { errors.push(`classify: ${String(e)}`); return ""; }
    };

    // (a) Classify the business from homepage text. The same fetch feeds the
    //     v4 probes: raw HTML, response headers, and a TTFB approximation.
    let bizText = "";
    let homeHtmlRaw = "", homeHeaders: Headers | null = null, ttfbMs: number | null = null, homeKB: number | null = null;
    try {
      const t0 = Date.now();
      const hr = await fetch(home, { headers: { "User-Agent": "Mozilla/5.0 (compatible; 44i-audit/1.0)" } });
      ttfbMs = Date.now() - t0;   // time-to-headers ≈ TTFB (+connect); good enough for grading
      homeHeaders = hr.headers;
      if (hr.ok) { const h = await hr.text();
        homeHtmlRaw = h; homeKB = Math.round(h.length / 1024);
        const heads = (h.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi) || []).map((x) => x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 12).join(" | ");
        const body = h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1800);
        bizText = `TITLE: ${getTitle(h)}\nMETA: ${getMeta(h, "description")}\nHEADINGS: ${heads}\nTEXT: ${body}`;
      }
    } catch { /* ignore */ }
    // The owner's own description (clients.intake.description) is authoritative:
    // it sharpens classification on thin sites and rescues it entirely when the
    // homepage is unreachable — better services/keywords flow from here.
    const ownerDesc = (client.intake && (client.intake as any).description) || "";
    if (ownerDesc) bizText = `${bizText ? bizText + "\n" : ""}OWNER DESCRIPTION (authoritative — provided by the business): ${ownerDesc}`;
    const cityHint = client.market || "";
    let businessType = "", services: string[] = [], seedKeywords: string[] = [], primaryCity = cityHint, secondaryTowns: string[] = [];
    if (bizText) {
      const raw = await writeAI(
        "You are a local SEO analyst. Identify a local trade/service business from its homepage and return ONLY compact JSON, no prose.",
        `Homepage:\n${bizText}\n\nKnown market (may be blank): "${cityHint}"\n\nReturn JSON exactly: {"business_type":"<3-5 word trade category>","primary_city":"<city, ST>","secondary_towns":["<nearby town in the same trade area, ST>", ...3-6],"services":["<core service>", ...up to 6],"seed_keywords":["<buyer-intent local keyword>", ...8-12]}. secondary_towns are real towns within ~30 miles this business would also serve. services are the actual trades offered. No brand name, no questions.`, 650);
      try { const j = JSON.parse(raw.replace(/```json|```/g, "").trim());
        businessType = String(j.business_type || ""); services = (j.services || []).map(String).slice(0, 6); seedKeywords = (j.seed_keywords || []).map(String).slice(0, 12);
        if (j.primary_city) primaryCity = String(j.primary_city); secondaryTowns = (j.secondary_towns || []).map(String).slice(0, 6);
      } catch { errors.push("classify parse failed"); }
      note.push(`Business: ${businessType || "unknown"} · primary ${primaryCity || "?"} · ${secondaryTowns.length} secondary towns · ${services.length} services.`);
    }
    const city = primaryCity || cityHint || "";
    const geoList = [primaryCity, ...secondaryTowns].map((g) => String(g).trim()).filter(Boolean);

    // (b) Research keywords across the FULL trade area: services × each geo + seeds.
    const candidateSet = new Set<string>();
    seedKeywords.forEach((k) => candidateSet.add(k.toLowerCase()));
    services.forEach((s) => {
      if (primaryCity) candidateSet.add(`${s} ${primaryCity}`.toLowerCase());
      candidateSet.add(`${s} near me`.toLowerCase());
      secondaryTowns.forEach((t) => candidateSet.add(`${s} ${t}`.toLowerCase()));
    });
    if (businessType && primaryCity) candidateSet.add(`${businessType} ${primaryCity}`.toLowerCase());
    ownKw.slice(0, 8).forEach((k: any) => candidateSet.add(String(k.keyword).toLowerCase()));
    const candidates = [...candidateSet].filter((k) => k && !junkKw(k)).slice(0, 30);
    let coreKeywords: any[] = [];
    if (candidates.length) {
      const ke = await ah("keywords-explorer/overview", { country: COUNTRY, keywords: candidates.join(","), select: "keyword,volume,difficulty,cpc,intents,serp_features" });
      coreKeywords = (ke?.keywords ?? []).filter((k: any) => k?.keyword)
        .map((k: any) => ({ keyword: k.keyword, volume: k.volume ?? 0, difficulty: k.difficulty ?? null, intents: k.intents || {}, serp_features: k.serp_features || [], owned: ownKwSet.has(String(k.keyword).toLowerCase()), pos: ownKwPos[String(k.keyword).toLowerCase()] ?? null }))
        .sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0));
      note.push(`Researched ${coreKeywords.length} trade-area keywords.`);
    }
    if (!coreKeywords.length) coreKeywords = ownKw.slice(0, 12).map((k: any) => ({ keyword: k.keyword, volume: k.volume ?? 0, difficulty: null, intents: {}, serp_features: sf(k), owned: true, pos: k.best_position }));

    // (c) LOCAL competitors only — seed SERPs with service×primary-city terms
    //     (NOT volume-gated; hyperlocal terms often lack reported volume). Read
    //     who actually ranks locally. National marketplaces/big-box/news are
    //     filtered, and there is NO national-competitor fallback for a local trade.
    const localSeeds = Array.from(new Set([
      ...services.map((s) => `${s} ${primaryCity}`),
      ...(businessType && primaryCity ? [`${businessType} ${primaryCity}`] : []),
      ...services.slice(0, 2).map((s) => `${s} near me`),
    ].map((s) => s.trim()).filter((s) => s && primaryCity))).slice(0, 8);
    const compTally = new Map<string, { domain: string; hits: number; localPack: boolean; dr: number | null; traffic: number | null }>();
    for (const seed of localSeeds) {
      const so = await ah("serp-overview", { keyword: seed, country: COUNTRY, top_positions: String(SERP_TOP), select: "position,type,url,domain_rating,traffic" });
      const seen = new Set<string>();
      for (const p of (so?.positions ?? [])) {
        const types = ([] as string[]).concat(p.type || []);
        if (!(types.includes("organic") || types.includes("local_pack") || types.includes("local_teaser")) || !p.url) continue;
        const d = rootOf(p.url);
        if (!d || d === root || seen.has(d) || PLATFORM_DENYLIST.some((x) => d.includes(x))) continue;
        seen.add(d);
        const cur = compTally.get(d) || { domain: d, hits: 0, localPack: false, dr: p.domain_rating ?? null, traffic: p.traffic ?? null };
        cur.hits += 1; if (types.includes("local_pack") || types.includes("local_teaser")) cur.localPack = true;
        compTally.set(d, cur);
      }
    }
    const competitors = [...compTally.values()]
      .sort((a, b) => (b.hits - a.hits) || ((b.localPack ? 1 : 0) - (a.localPack ? 1 : 0)))
      .slice(0, COMP_KEEP)
      .map((c) => ({ domain: c.domain, domain_rating: c.dr, common_keywords: c.hits, total_keywords: null, overlap_pct: null, org_traffic: c.traffic, source: c.localPack ? "serp_local" : "serp", localPack: c.localPack }));
    if (!competitors.length) note.push("No local competitors surfaced for the trade-area terms — verify market/services.");
    else note.push(`${competitors.length} LOCAL competitors identified from trade-area SERPs.`);
    const serpLocal = competitors.filter((c) => c.localPack);
    const serpSeed = localSeeds[0] || "";

    // (d) OPPORTUNITY + AUTHORITY — the real story for a low-authority local site:
    //     high-value trade keywords the client doesn't own or ranks poorly for
    //     (e.g. ranking #28 for a 2,300-volume term), the authority gap vs local
    //     competitors, and how much of their traffic is just their own brand name.
    const oppFromCore = coreKeywords.filter((k: any) => (k.volume || 0) >= 30 && (!k.owned || (k.pos || 99) > 10))
      .map((k: any) => ({ keyword: k.keyword, volume: k.volume, position: k.pos, difficulty: k.difficulty, source: k.owned ? "ranking_low" : "not_ranking" }));
    const oppFromOwn = ownKw.filter((k: any) => (k.volume || 0) >= 50 && k.best_position != null && k.best_position > 10)
      .map((k: any) => ({ keyword: k.keyword, volume: k.volume, position: k.best_position, difficulty: null, source: "ranking_low" }));
    const oppMap = new Map<string, any>();
    [...oppFromOwn, ...oppFromCore].forEach((o) => { const key = String(o.keyword).toLowerCase(); if (!oppMap.has(key)) oppMap.set(key, o); });
    const opportunities = [...oppMap.values()].filter((o) => !junkKw(o.keyword)).sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 12);
    const compDRs = competitors.map((c) => c.domain_rating).filter((d): d is number => d != null);
    const medianCompDR = compDRs.length ? compDRs.slice().sort((a, b) => a - b)[Math.floor(compDRs.length / 2)] : null;
    const brandedTraffic = ownKw.filter((k: any) => k.is_branded).reduce((a: number, k: any) => a + (k.sum_traffic || 0), 0);
    const nonBrandedTraffic = Math.max(0, (org_traffic || 0) - brandedTraffic);

    // ── 4. COMPETITOR WINNING PAGES ───────────────────────────────────────────
    const compPages: any[] = [];
    for (const c of competitors.slice(0, COMP_PAGES_FROM)) {
      const tp = await ah("site-explorer/top-pages", { target: c.domain, date: today, country: COUNTRY, mode: "subdomains", limit: String(COMP_PAGES_EACH), order_by: "sum_traffic:desc",
        select: "url,top_keyword,top_keyword_best_position,sum_traffic" });
      (tp?.pages ?? []).forEach((p: any) => { if (p?.url) compPages.push({ domain: c.domain, url: p.url, top_keyword: p.top_keyword, position: p.top_keyword_best_position, traffic: p.sum_traffic }); });
    }

    // ── 4b. BACKLINK INTELLIGENCE — referring-domain quality + competitor
    //        link gap: domains linking to the local rivals but NOT the client
    //        are the exact citation/link targets to pursue.
    let linkProfile: any = null;
    const linkGap: any[] = [];
    {
      const rd = await ah("site-explorer/refdomains", { target, date: today, mode: "subdomains", limit: "100", order_by: "domain_rating:desc", select: "domain,domain_rating" });
      const ours = (rd?.refdomains ?? []).filter((r: any) => r?.domain);
      if (ours.length) {
        const low = ours.filter((r: any) => (r.domain_rating ?? 0) < 10).length;
        linkProfile = { sampled: ours.length, lowDrPct: Math.round((100 * low) / ours.length), topDomains: ours.slice(0, 10) };
      }
      const ourSet = new Set(ours.map((r: any) => rootOf(r.domain)));
      const gapTally = new Map<string, any>();
      for (const c of competitors.slice(0, 2)) {
        const crd = await ah("site-explorer/refdomains", { target: c.domain, date: today, mode: "subdomains", limit: String(LINKGAP_LIMIT), order_by: "domain_rating:desc", select: "domain,domain_rating" });
        for (const r of (crd?.refdomains ?? [])) {
          const dm = rootOf(r?.domain); if (!dm || ourSet.has(dm) || dm === root || PLATFORM_DENYLIST.some((x) => dm.includes(x))) continue;
          const cur = gapTally.get(dm) || { domain: dm, dr: r.domain_rating ?? null, links_competitors: 0 };
          cur.links_competitors += 1; if (r.domain_rating != null) cur.dr = r.domain_rating;
          gapTally.set(dm, cur);
        }
      }
      linkGap.push(...[...gapTally.values()]
        .sort((a, b) => (b.links_competitors - a.links_competitors) || ((b.dr ?? 0) - (a.dr ?? 0)))
        .slice(0, LINKGAP_KEEP));
      if (linkGap.length) note.push(`Link gap: ${linkGap.length} domains link to local competitors but not the client.`);
    }

    // ── 5. CLIENT TOP PAGES ───────────────────────────────────────────────────
    const ctp = await ah("site-explorer/top-pages", { target, date: today, country: COUNTRY, mode: "subdomains", limit: String(CLIENT_PAGES), order_by: "sum_traffic:desc",
      select: "url,top_keyword,sum_traffic,keywords" });
    const clientTopPages = (ctp?.pages ?? []).filter((p: any) => p?.url).map((p: any) => ({ url: p.url, top_keyword: p.top_keyword, traffic: p.sum_traffic, keywords: p.keywords }));

    // ── 6. CONTENT GAPS (real diff vs the strongest competitor) ───────────────
    let gaps: any[] = [];
    if (competitors[0]?.domain) {
      const gkw = await ah("site-explorer/organic-keywords", { target: competitors[0].domain, date: today, country: COUNTRY, mode: "subdomains", limit: String(GAP_SOURCE_LIMIT), order_by: "sum_traffic:desc",
        select: "keyword,best_position,volume,is_commercial,is_informational,is_local,is_transactional" });
      const intentOf = (k: any) => k.is_transactional ? "transactional" : k.is_commercial ? "commercial" : k.is_local ? "local" : k.is_informational ? "informational" : null;
      gaps = (gkw?.keywords ?? []).filter((k: any) => k?.keyword).map((k: any) => { const kw=String(k.keyword).toLowerCase(); const ourPos=ownKwSet.has(kw)?ownKwPos[kw]:null;
        return { keyword: k.keyword, competitor_domain: competitors[0].domain, their_position: k.best_position, our_position: ourPos, volume: k.volume, difficulty: null, intent: intentOf(k), _isGap: ourPos==null||ourPos>20 }; })
        .filter((g: any) => g._isGap && !junkKw(g.keyword)).slice(0, GAP_KEEP);
    }

    // ── 7. SITE COVERAGE: CRAWL (UPGRADE #1) or FALLBACK FETCH ─────────────────
    // Always fetch homepage + an about page for E-E-A-T / NAP body-text signals
    // (the crawl API returns page metrics, not the prose we scan for those).
    const aboutGuess = clientTopPages.map((p: any) => p.url).find((u: string) => /about|team|staff|bio|story/i.test(u));
    const [homePage, aboutPage] = await Promise.all([ fetchPage(home), aboutGuess ? fetchPage(aboutGuess) : Promise.resolve(null) ]);

    // Resolve a crawl project: stored id first, else auto-discover by domain.
    let crawlProjectId: number | null = client.ahrefs_site_audit_project_id ? Number(client.ahrefs_site_audit_project_id) : null;
    let healthScore: number | null = null; let crawlTotals: any = null; let crawlIssues: any[] = []; let crawlUsed = false;
    let pages: any[] = [];   // the audited page set (crawl pages OR fetched sample)

    if (!crawlProjectId) {
      const pj = await ah("site-audit/projects", { project_url: root });
      const hit = (pj?.healthscores ?? []).find((p: any) => rootOf(p.target_url) === root) || (pj?.healthscores ?? [])[0];
      if (hit?.project_id) { crawlProjectId = Number(hit.project_id); healthScore = hit.health_score ?? null; crawlTotals = { total: hit.total, errors: hit.urls_with_errors, warnings: hit.urls_with_warnings, notices: hit.urls_with_notices }; }
    } else {
      const pj = await ah("site-audit/projects", { project_id: String(crawlProjectId) });
      const hit = (pj?.healthscores ?? [])[0];
      if (hit) { healthScore = hit.health_score ?? null; crawlTotals = { total: hit.total, errors: hit.urls_with_errors, warnings: hit.urls_with_warnings, notices: hit.urls_with_notices }; }
    }

    if (crawlProjectId) {
      // Real issues → technical findings.
      const iss = await ah("site-audit/issues", { project_id: String(crawlProjectId) });
      crawlIssues = (iss?.issues ?? []).filter((i: any) => (i.crawled || 0) > 0);
      // Per-page crawl data → audit EVERY page.
      const pe = await ah("site-audit/page-explorer", { project_id: String(crawlProjectId), limit: String(CRAWL_PAGE_LIMIT), order_by: "page_rating:desc",
        select: "url,http_code,page_is_noindex,title,titles_length,meta_description,meta_description_length,h1,h1_length,content_nr_word,links_count_images,links_count_images_without_alt,jsonld_schema_types,canonical,og_tags_valid,page_type" });
      const rows = (pe?.pages ?? pe?.rows ?? []);
      pages = rows
        .filter((r: any) => r && (r.http_code === undefined || (r.http_code >= 200 && r.http_code < 400)))
        .filter((r: any) => (r.title || r.content_nr_word))   // HTML pages only
        .map((r: any) => {
          const st = Array.isArray(r.jsonld_schema_types) ? r.jsonld_schema_types : String(r.jsonld_schema_types || "").split(/[,\s]+/).filter(Boolean);
          return { url: r.url, status: r.http_code ?? 200, ok: true, https: String(r.url||"").startsWith("https://"),
            title: r.title || "", titleLen: r.titles_length ?? (r.title||"").length, metaDesc: r.meta_description || "", metaLen: r.meta_description_length ?? (r.meta_description||"").length,
            h1: r.h1_length > 0 || r.h1 ? 1 : 0, words: r.content_nr_word ?? 0,
            imgs: r.links_count_images ?? 0, imgsNoAlt: r.links_count_images_without_alt ?? 0,
            schemaTypes: st, og: !!r.og_tags_valid, canonical: !!r.canonical, viewport: true, noindex: !!r.page_is_noindex,
            aeo: { hasFAQSchema: st.includes("FAQPage"), questionHeadings: 0 } };
        });
      if (pages.length) { crawlUsed = true; note.push(`Full-site crawl used (${pages.length} pages audited; health ${healthScore ?? "—"}).`); }
    }
    let sitemapCrawled = false;
    if (!crawlUsed) {
      // Fallback: LIGHTWEIGHT SITEMAP CRAWL — audit up to SITEMAP_CRAWL pages
      // straight from /sitemap.xml (one level of sitemapindex followed), no
      // paid crawl project needed. Last resort: homepage + top pages.
      let smList: string[] = [];
      try {
        const smr = await fetch(`https://${target}/sitemap.xml`);
        if (smr.ok) {
          let xml = await smr.text();
          if (/<sitemapindex/i.test(xml)) {
            const first = xml.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
            if (first) { try { const cs = await fetch(first.trim()); if (cs.ok) xml = await cs.text(); } catch { /* ignore */ } }
          }
          smList = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim())
            .filter((u) => rootOf(u) === root && !/\.(jpg|jpeg|png|gif|webp|svg|pdf|xml)(\?|$)/i.test(u));
        }
      } catch { /* ignore */ }
      const targets = [home, ...clientTopPages.map((p: any) => p.url), ...smList]
        .filter((u, i, a) => u && a.indexOf(u) === i).slice(0, smList.length ? SITEMAP_CRAWL : FETCH_PAGES);
      const fetched = await Promise.all(targets.map((u) => u === home ? Promise.resolve(homePage) : fetchPage(u)));
      pages = fetched.filter(Boolean);
      const okN = pages.filter((p: any) => p.ok).length;
      sitemapCrawled = smList.length > 0 && okN >= 10;
      note.push(sitemapCrawled
        ? `Lightweight sitemap crawl: ${okN} pages audited (no crawl project needed).`
        : `No crawl project found — sampled ${okN} pages. Set up a crawl for full-site coverage.`);
    }
    const okPages = pages.filter((p: any) => p.ok);

    // Schema coverage (aggregate across audited pages + the fetched home/about).
    const allSchema = new Set<string>();
    pages.forEach((p: any) => (p.schemaTypes || []).forEach((t: string) => allSchema.add(t)));
    [homePage, aboutPage].forEach((p: any) => p && (p.schemaTypes || []).forEach((t: string) => allSchema.add(t)));
    const schemaPresent = EXPECT_SCHEMA.filter((t) => allSchema.has(t) || (t === "Organization" && allSchema.has("LocalBusiness")));
    const hasFAQ = allSchema.has("FAQPage");
    const questionHeads = (homePage?.aeo?.questionHeadings || 0) + (aboutPage?.aeo?.questionHeadings || 0);
    const hasNAP = !!(homePage?.nap?.hasPhone && homePage?.nap?.hasAddress);
    const eeat = { ...(aboutPage?.eeat || {}), ...(homePage?.eeat || {}),
      hasPerson: !!(homePage?.eeat?.hasPerson || aboutPage?.eeat?.hasPerson || allSchema.has("Person")),
      hasReviews: !!(homePage?.eeat?.hasReviews || aboutPage?.eeat?.hasReviews || allSchema.has("AggregateRating")),
      hasAbout: !!(homePage?.eeat?.hasAbout || aboutPage?.eeat?.hasAbout || aboutGuess),
      hasCredentials: !!(homePage?.eeat?.hasCredentials || aboutPage?.eeat?.hasCredentials) };

    // ── 8. SITE PROBES — robots, sitemap, redirects, 404s, security, trust,
    //       AEO files. The fetch-based checks third-party audit tools grade.
    //       Every probe is defensive: a network failure records "na", never a
    //       fabricated fail.
    let robotsOk = true, robotsFound = false, sitemapOk = false, sitemapDeclared = false, robotsTxt = "";
    try { const rb = await fetch(`https://${target}/robots.txt`); robotsFound = rb.ok; robotsTxt = rb.ok ? await rb.text() : "";
      robotsOk = !/^\s*Disallow:\s*\/\s*$/im.test(robotsTxt); sitemapDeclared = /sitemap:/i.test(robotsTxt); } catch { /* ignore */ }
    const sitemapUrl = robotsTxt.match(/sitemap:\s*(\S+)/i)?.[1] || `https://${target}/sitemap.xml`;
    let smUrls: number | null = null, smIsIndex = false;
    try { const sm = await fetch(sitemapUrl); if (sm.ok) { const xml = await sm.text();
      sitemapOk = /<(urlset|sitemapindex)/i.test(xml); smIsIndex = /<sitemapindex/i.test(xml);
      smUrls = (xml.match(/<loc>/gi) || []).length; } } catch { /* ignore */ }

    // HTTP→HTTPS redirect + host canonicalization (duplicate-host detection).
    let httpsRedirect: boolean | null = null, hostCanonical: boolean | null = null;
    try { const r = await fetch(`http://${target}/`, { redirect: "manual" });
      httpsRedirect = r.status >= 300 && r.status < 400 && String(r.headers.get("location") || "").startsWith("https");
      await r.body?.cancel(); } catch { /* ignore */ }
    const altHost = target.startsWith("www.") ? target.replace(/^www\./, "") : `www.${target}`;
    try { const r = await fetch(`https://${altHost}/`, { redirect: "manual" });
      // alt host redirecting (30x) is correct; 200 on both hosts = duplicate content
      hostCanonical = r.status >= 300; await r.body?.cancel();
    } catch { hostCanonical = true; /* alt host doesn't resolve — no duplicate */ }

    // Soft-404 detection: a made-up URL must return a real 404/410.
    let notFoundOk: boolean | null = null;
    try { const r = await fetch(`https://${target}/44i-audit-nonexistent-${Math.random().toString(36).slice(2, 8)}`, { redirect: "follow" });
      notFoundOk = r.status === 404 || r.status === 410; await r.body?.cancel(); } catch { /* ignore */ }

    // llms.txt (AI-crawler guidance) + favicon.
    let llmsTxt = false; try { const r = await fetch(`https://${target}/llms.txt`); llmsTxt = r.ok && (await r.text()).trim().length > 0; } catch { /* ignore */ }
    let favicon = /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(homeHtmlRaw);
    if (!favicon) { try { const r = await fetch(`https://${target}/favicon.ico`); favicon = r.ok; await r.body?.cancel(); } catch { /* ignore */ } }

    // Security headers on the homepage response.
    const hdr = (n: string) => homeHeaders?.get(n) || "";
    const secHeaders = homeHeaders ? {
      hsts: !!hdr("strict-transport-security"),
      nosniff: hdr("x-content-type-options").toLowerCase().includes("nosniff"),
      frame: !!hdr("x-frame-options") || /frame-ancestors/i.test(hdr("content-security-policy")),
      referrer: !!hdr("referrer-policy"),
    } : null;
    const secMissing = secHeaders ? Object.entries({
      "Strict-Transport-Security": secHeaders.hsts, "X-Content-Type-Options": secHeaders.nosniff,
      "X-Frame-Options/frame-ancestors": secHeaders.frame, "Referrer-Policy": secHeaders.referrer,
    }).filter(([, v]) => !v).map(([k]) => k) : [];

    // Homepage-HTML signals (social cards, canonical, i18n, analytics, trust).
    const mixedContent = homeHtmlRaw ? (homeHtmlRaw.match(/\s(?:src|srcset)=["']http:\/\//gi) || []).length : null;
    const ogTitle = getMeta(homeHtmlRaw, "og:title"), ogDesc = getMeta(homeHtmlRaw, "og:description"), ogImage = getMeta(homeHtmlRaw, "og:image");
    const ogComplete = !!(ogTitle && ogDesc && ogImage);
    const twitterCard = !!getMeta(homeHtmlRaw, "twitter:card");
    const canonicalHref = homeHtmlRaw.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1] || "";
    const normUrl = (u: string) => String(u || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").toLowerCase();
    const canonicalSelf = canonicalHref ? normUrl(canonicalHref) === normUrl(home) : false;
    const langAttr = /<html[^>]+lang=["']?[a-z]{2}/i.test(homeHtmlRaw);
    const charsetOk = /<meta[^>]+charset/i.test(homeHtmlRaw) || /charset=/i.test(hdr("content-type"));
    const analytics = /gtag\(|googletagmanager\.com|google-analytics\.com|gtm\.js|fbq\(|clarity\.ms|plausible\.io|matomo/i.test(homeHtmlRaw);
    const privacyLink = /href=["'][^"']*(privacy|legal|terms)[^"']*["']/i.test(homeHtmlRaw);
    const contactLink = /href=["'][^"']*(contact|about)[^"']*["']/i.test(homeHtmlRaw) || !!aboutGuess;
    const telLink = /href=["']tel:/i.test(homeHtmlRaw);
    const mapPresence = /google\.com\/maps|maps\.app\.goo|g\.page|maps\.google/i.test(homeHtmlRaw);
    const homeNoindex = /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(homeHtmlRaw) || /noindex/i.test(hdr("x-robots-tag"));

    // ── 8c. INTAKE SUGGESTIONS — scrape candidate business facts from the
    //        live site (schema first, text patterns second) for HUMAN APPROVAL
    //        in the console. Never auto-trusted, never written to intake here.
    const intakeSuggested: Record<string, string> = {};
    if (homeHtmlRaw) {
      const h = homeHtmlRaw;
      const text = h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
      const tel = h.match(/href=["']tel:([^"']+)["']/i)?.[1] || text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/)?.[0] || "";
      if (tel) intakeSuggested.phone = tel.replace(/^tel:/i, "").trim();
      const mail = h.match(/href=["']mailto:([^"'?]+)/i)?.[1]; if (mail) intakeSuggested.email = mail.trim();
      const sv = (k: string) => h.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`))?.[1];
      if (sv("streetAddress")) intakeSuggested.street = sv("streetAddress")!;
      if (sv("addressLocality")) intakeSuggested.city = sv("addressLocality")!;
      if (sv("addressRegion")) intakeSuggested.state = sv("addressRegion")!;
      if (sv("postalCode")) intakeSuggested.zip = sv("postalCode")!;
      if (sv("openingHours")) intakeSuggested.hours = sv("openingHours")!;
      if (!intakeSuggested.street) {
        const am = text.match(/(\d{1,5}\s+[A-Za-z0-9. ]{3,40}?(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Hwy)\.?)\s*,?\s*([A-Z][A-Za-z .]{2,25}),?\s*([A-Z]{2})\s+(\d{5})/);
        if (am) { intakeSuggested.street = am[1].trim(); intakeSuggested.city = intakeSuggested.city || am[2].trim(); intakeSuggested.state = intakeSuggested.state || am[3]; intakeSuggested.zip = intakeSuggested.zip || am[4]; }
      }
      const so = (re: RegExp) => h.match(re)?.[0];
      const fb = so(/https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.\-]+/i); if (fb && !/sharer|plugins|\/tr\b/i.test(fb)) intakeSuggested.facebook = fb;
      const ig = so(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.\-]+/i); if (ig) intakeSuggested.instagram = ig;
      const li = so(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_.\-]+/i); if (li) intakeSuggested.linkedin = li;
      const gb = so(/https?:\/\/(?:goo\.gl\/maps|maps\.app\.goo\.gl|g\.page)\/[A-Za-z0-9_.\-]+/i); if (gb) intakeSuggested.gbp = gb;
      if (Object.keys(intakeSuggested).length) note.push(`Intake: ${Object.keys(intakeSuggested).length} business facts scraped from the site, awaiting approval in the console.`);
    }

    // ── 8b. PERFORMANCE — Google PageSpeed Insights (free API; key optional
    //        via PAGESPEED_API_KEY). Prefers real-user CrUX field data, falls
    //        back to lab data, then to our own TTFB/payload heuristics.
    let psi: any = null;
    try {
      const PSI_KEY = Deno.env.get("PAGESPEED_API_KEY") || "";
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
      const pr = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(home)}&strategy=mobile&category=performance${PSI_KEY ? `&key=${PSI_KEY}` : ""}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (pr.ok) {
        const d = await pr.json(); const lh = d.lighthouseResult; const au = lh?.audits ?? {}; const cx = d.loadingExperience?.metrics ?? {};
        const ms = (k: string) => au[k]?.numericValue ?? null;
        psi = {
          score: lh?.categories?.performance?.score != null ? Math.round(lh.categories.performance.score * 100) : null,
          lcp_ms: cx.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? ms("largest-contentful-paint"),
          cls: cx.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? cx.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : ms("cumulative-layout-shift"),
          inp_ms: cx.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
          tbt_ms: ms("total-blocking-time"),
          ttfb_ms: cx.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile ?? ms("server-response-time"),
          field: !!d.loadingExperience?.metrics,
          fixables: ["render-blocking-resources", "modern-image-formats", "uses-responsive-images", "uses-text-compression", "unused-javascript", "uses-long-cache-ttl"]
            .filter((k) => au[k] && au[k].score != null && au[k].score < 0.9).map((k) => au[k].title || k),
        };
        note.push(`PageSpeed measured (mobile perf ${psi.score ?? "—"}, ${psi.field ? "field" : "lab"} data).`);
      } else { errors.push(`pagespeed ${pr.status}: ${(await pr.text()).slice(0, 120)}`); }
    } catch (e) { errors.push(`pagespeed: ${String(e)}`); }
    if (!psi) { psi = { score: null, lcp_ms: null, cls: null, inp_ms: null, tbt_ms: null, ttfb_ms: ttfbMs, field: false, fixables: [] };
      note.push("PageSpeed unavailable — performance graded from response-time heuristics only."); }

    // ── 9. AI-CITATION / SHARE OF VOICE (UPGRADE #2) ──────────────────────────
    const businessName = homePage?.orgName || (homePage?.title ? homePage.title.split(/[|\-–—:]/)[0].trim() : "") || root;
    const competitorNames = competitors.map((c: any) => c.domain).slice(0, 5).join(",");
    let brandRadar: any = null;
    {
      const common: Record<string, string> = { data_source: AI_SOURCES, country: COUNTRY };
      if (client.brand_radar_report_id) common.report_id = String(client.brand_radar_report_id);
      else { common.brand = businessName; if (competitorNames) common.competitors = competitorNames; }
      const sov = await ah("brand-radar/sov-overview", { ...common });
      const men = await ah("brand-radar/mentions-overview", { ...common, select: "brand,total,only_target_brand,only_competitors_brands,target_and_competitors_brands" });
      if (sov?.metrics || men?.metrics) {
        const sovRows = sov?.metrics ?? []; const menRows = men?.metrics ?? [];
        const norm = (s: string) => String(s || "").toLowerCase();
        const isUs = (b: string) => norm(b) === norm(businessName) || norm(b).includes(rootOf(b)) || norm(businessName).includes(norm(b));
        const ourSov = sovRows.find((r: any) => isUs(r.brand))?.share_of_voice ?? 0;
        const ourMen = menRows.find((r: any) => isUs(r.brand));
        const compSov = sovRows.filter((r: any) => !isUs(r.brand)).reduce((a: number, r: any) => a + (r.share_of_voice || 0), 0);
        const topCompSov = sovRows.filter((r: any) => !isUs(r.brand)).sort((a: any, b: any) => (b.share_of_voice||0)-(a.share_of_voice||0))[0] || null;
        brandRadar = { ourSov, compSov, topCompetitor: topCompSov ? { brand: topCompSov.brand, sov: topCompSov.share_of_voice } : null,
          mentions: ourMen?.total ?? 0, onlyCompetitors: ourMen?.only_competitors_brands ?? 0, sovRows, configured: !!client.brand_radar_report_id };
        note.push(`AI-citation measured across ${AI_SOURCES.split(",").length} assistants (SoV ${(ourSov*100||0).toFixed(0)}%).`);
      } else { note.push("AI-citation data unavailable on current plan — AEO graded from SERP features + on-page readiness."); }
    }

    // ── 10. GSC (real Google data, if present) ────────────────────────────────
    const { data: gscRows } = await supa.from("gsc_queries").select("query, clicks, impressions, ctr, position").eq("client_id", client.id).order("clicks", { ascending: false }).limit(50);
    const gsc = gscRows ?? [];
    const gscClicks = gsc.reduce((a, r) => a + (r.clicks || 0), 0), gscImpr = gsc.reduce((a, r) => a + (r.impressions || 0), 0);
    const striking = gsc.filter((r) => r.position >= 5 && r.position <= 15 && r.impressions >= 50);
    const ctrBleed = gsc.filter((r) => r.impressions >= 200 && (r.ctr || 0) < 0.01);

    // ── 11. CHECKLIST ENGINE ──────────────────────────────────────────────────
    // Every pillar score is a weighted pass-rate over the exhaustive check
    // registry (the union of what third-party SEO auditors grade). pass = full
    // weight, warn = half, fail = 0, na = excluded. A green checklist IS a top
    // external score by construction. Each check carries the fix kind, the
    // remediation action, and the plan SERVICE that covers it — the directive
    // builder (section 16) scopes those to the client's tier.
    type ChkStatus = "pass" | "warn" | "fail" | "na";
    const CL: any[] = [];
    const check = (id: string, pillar: string, weight: number, label: string, status: ChkStatus, evidence: string, fix_kind: string | null, action: string, service: string, engine = "fix") =>
      CL.push({ id, pillar, weight, label, status, evidence, fix_kind, action, service, engine });
    const B = (b: boolean | null | undefined): ChkStatus => b == null ? "na" : b ? "pass" : "fail";
    const pctStatus = (good: number, total: number, passAt = 0.9, warnAt = 0.6): ChkStatus =>
      total === 0 ? "na" : (good / total) >= passAt ? "pass" : (good / total) >= warnAt ? "warn" : "fail";

    // On-page tallies (shared with the findings engine below).
    const noTitle = okPages.filter((p: any) => !p.title || p.titleLen < 20 || p.titleLen > 65);
    const noMeta  = okPages.filter((p: any) => !p.metaDesc || p.metaLen < 70 || p.metaLen > 165);
    const badH1   = okPages.filter((p: any) => p.h1 !== 1);
    const thin    = okPages.filter((p: any) => p.words < 300);
    const noAlt   = okPages.filter((p: any) => p.imgsNoAlt > 0);
    const dupOf = (get: (p: any) => string) => { const m = new Map<string, number>();
      okPages.forEach((p: any) => { const t = get(p).trim().toLowerCase(); if (t) m.set(t, (m.get(t) || 0) + 1); });
      return [...m.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0); };
    const dupTitles = dupOf((p) => p.title || ""), dupMetas = dupOf((p) => p.metaDesc || "");
    const badUrls = okPages.filter((p: any) => /[A-Z_]|\?[^ ]*=/.test(String(p.url).replace(/^https?:\/\/[^/]*/, "")) || String(p.url).length > 115);
    const townCovered = okPages.some((p: any) => secondaryTowns.some((t: string) => String(p.title || "").toLowerCase().includes(String(t).split(",")[0].trim().toLowerCase())));

    // TECHNICAL
    check("https", "technical", 3, "Site served over HTTPS", B(homePage?.ok ? homePage.https : null), homePage?.ok && !homePage.https ? "homepage is not https" : "", null, "Install/repair SSL and force HTTPS site-wide.", "Site Health Scan");
    check("https_redirect", "technical", 2, "HTTP 301-redirects to HTTPS", B(httpsRedirect), httpsRedirect === false ? "http:// version does not redirect to https://" : "", "redirect_map", "301-redirect every http:// URL to its https:// twin.", "Domain Optimization (404 fixes, 301 redirects)");
    check("host_canonical", "technical", 1, "Single canonical host (www vs non-www)", B(hostCanonical), hostCanonical === false ? `both ${target} and ${altHost} serve 200` : "", "redirect_map", "301-redirect the duplicate host to the canonical one.", "Domain Optimization (404 fixes, 301 redirects)");
    check("robots_valid", "technical", 2, "robots.txt present and not blocking", robotsFound ? (robotsOk ? "pass" : "fail") : "warn", !robotsFound ? "no robots.txt" : robotsOk ? "" : "site-wide Disallow found", "robots_txt", "Publish a correct robots.txt that allows crawling and declares the sitemap.", "Sitemap Refresh");
    check("sitemap_present", "technical", 2, "XML sitemap exists and parses", B(sitemapOk), sitemapOk ? (smIsIndex ? "sitemap index" : `${smUrls ?? 0} URLs`) : "no valid sitemap.xml", "sitemap_xml", "Generate an XML sitemap and submit it in Search Console.", "Sitemap Refresh");
    check("sitemap_declared", "technical", 1, "Sitemap declared in robots.txt", B(sitemapDeclared), "", "robots_txt", "Add a Sitemap: line to robots.txt.", "Sitemap Refresh");
    check("custom_404", "technical", 1, "Unknown URLs return a real 404", B(notFoundOk), notFoundOk === false ? "nonexistent URL returned non-404 (soft 404)" : "", null, "Serve a 404 status (custom 404 template) for missing pages.", "Domain Optimization (404 fixes, 301 redirects)");
    check("home_indexable", "technical", 3, "Homepage is indexable", homeHtmlRaw ? B(!homeNoindex) : "na", homeNoindex ? "noindex on the homepage" : "", null, "Remove the noindex directive from the homepage.", "Site Health Scan");
    check("crawl_health", "technical", 3, "Crawl health (full-site)", crawlUsed && healthScore != null ? (healthScore >= 90 ? "pass" : healthScore >= 75 ? "warn" : "fail") : "na", healthScore != null ? `health ${healthScore}; ${crawlTotals?.errors ?? "?"} pages with errors` : "", null, "Resolve the crawl-issue list until site health is 90+.", "Site Health Scan");
    check("crawl_coverage", "technical", 2, "Full-site crawl coverage", crawlUsed ? "pass" : sitemapCrawled ? "warn" : "fail", crawlUsed ? "" : sitemapCrawled ? `lightweight sitemap crawl — ${okPages.length} pages audited` : `no crawl configured — only ${okPages.length} page(s) sampled; site-wide claims are capped`, null, "Configure a crawl project so every page is audited, not a sample.", "Site Health Scan");
    check("mixed_content", "technical", 2, "No mixed content on HTTPS pages", mixedContent == null ? "na" : B(mixedContent === 0), mixedContent ? `${mixedContent} http:// resources embedded` : "", null, "Serve every script/image/stylesheet over https://.", "Site Health Scan");
    check("security_headers", "technical", 1, "Security headers set", secHeaders == null ? "na" : (secMissing.length === 0 ? "pass" : secMissing.length <= 2 ? "warn" : "fail"), secMissing.length ? `missing: ${secMissing.join(", ")}` : "", "security_headers", "Add HSTS, X-Content-Type-Options, frame-ancestors and Referrer-Policy headers.", "Site Health Scan");
    check("viewport", "technical", 2, "Mobile viewport tag", B(homePage?.ok ? !!homePage.viewport : null), "", null, "Add a responsive viewport meta tag.", "Core SEO Monitoring");
    check("lang_attr", "technical", 1, "<html lang> attribute", homeHtmlRaw ? B(langAttr) : "na", "", null, "Declare the page language on the <html> tag.", "Core SEO Monitoring");
    check("charset", "technical", 1, "Character encoding declared", homeHtmlRaw ? B(charsetOk) : "na", "", null, "Add <meta charset=\"utf-8\"> early in <head>.", "Core SEO Monitoring");
    check("favicon", "technical", 1, "Favicon present", B(favicon), "", "favicon", "Add a favicon + apple-touch-icon so the brand shows in tabs and SERPs.", "Core SEO Monitoring");
    check("analytics", "technical", 1, "Analytics/measurement installed", homeHtmlRaw ? B(analytics) : "na", analytics ? "" : "no GA4/GTM/pixel detected", null, "Install GA4 (or equivalent) so results are measurable.", "Monthly Reporting", "reporting");

    // PERFORMANCE (Core Web Vitals)
    check("psi_perf", "performance", 3, "PageSpeed performance (mobile)", psi.score == null ? "na" : (psi.score >= 90 ? "pass" : psi.score >= 50 ? "warn" : "fail"), psi.score != null ? `score ${psi.score}/100` : "", null, "Work the PageSpeed opportunity list until the mobile score is 90+.", "Site Health Scan");
    check("lcp", "performance", 2, "Largest Contentful Paint ≤ 2.5s", psi.lcp_ms == null ? "na" : (psi.lcp_ms <= 2500 ? "pass" : psi.lcp_ms <= 4000 ? "warn" : "fail"), psi.lcp_ms != null ? `${(psi.lcp_ms / 1000).toFixed(1)}s` : "", null, "Preload + compress the hero image; serve modern formats (WebP/AVIF).", "Site Health Scan");
    check("cls", "performance", 2, "Cumulative Layout Shift ≤ 0.1", psi.cls == null ? "na" : (psi.cls <= 0.1 ? "pass" : psi.cls <= 0.25 ? "warn" : "fail"), psi.cls != null ? String(Math.round(psi.cls * 100) / 100) : "", null, "Reserve space for images/embeds; avoid layout-shifting injections.", "Site Health Scan");
    check("inp", "performance", 2, "Interactivity (INP ≤ 200ms / TBT ≤ 200ms)", (psi.inp_ms ?? psi.tbt_ms) == null ? "na" : ((psi.inp_ms ?? psi.tbt_ms) <= 200 ? "pass" : (psi.inp_ms ?? psi.tbt_ms) <= 500 ? "warn" : "fail"), (psi.inp_ms ?? psi.tbt_ms) != null ? `${psi.inp_ms ?? psi.tbt_ms}ms` : "", null, "Defer/trim JavaScript; break up long main-thread tasks.", "Site Health Scan");
    check("ttfb", "performance", 1, "Server response ≤ 800ms", (psi.ttfb_ms ?? ttfbMs) == null ? "na" : ((psi.ttfb_ms ?? ttfbMs) <= 800 ? "pass" : (psi.ttfb_ms ?? ttfbMs) <= 1800 ? "warn" : "fail"), `${psi.ttfb_ms ?? ttfbMs}ms`, null, "Enable page caching / a CDN, or upgrade hosting, to cut TTFB.", "Site Health Scan");
    check("perf_fixables", "performance", 1, "No major PageSpeed opportunities", psi.score == null ? "na" : (psi.fixables.length === 0 ? "pass" : psi.fixables.length <= 2 ? "warn" : "fail"), psi.fixables.slice(0, 4).join("; "), null, "Fix the flagged items: compression, image formats, render-blocking resources, caching.", "Site Health Scan");

    // ON-PAGE
    check("titles_ok", "onpage", 3, "Title tags well-formed site-wide", pctStatus(okPages.length - noTitle.length, okPages.length), noTitle.length ? `${noTitle.length}/${okPages.length} pages weak/missing` : "", "title_tag", "Rewrite to unique 50–60 char titles with keyword + location.", "Core SEO Monitoring");
    check("titles_unique", "onpage", 2, "No duplicate titles", okPages.length > 1 ? B(dupTitles === 0) : "na", dupTitles ? `${dupTitles} pages share a title` : "", "title_tag", "Differentiate duplicate titles by page topic.", "Core SEO Monitoring");
    check("metas_ok", "onpage", 3, "Meta descriptions well-formed", pctStatus(okPages.length - noMeta.length, okPages.length), noMeta.length ? `${noMeta.length}/${okPages.length} pages weak/missing` : "", "meta_description", "Write 150–160 char descriptions with keyword + CTA.", "Core SEO Monitoring");
    check("metas_unique", "onpage", 1, "No duplicate meta descriptions", okPages.length > 1 ? B(dupMetas === 0) : "na", dupMetas ? `${dupMetas} pages share a description` : "", "meta_description", "Write a unique description per page.", "Core SEO Monitoring");
    check("h1_ok", "onpage", 2, "Exactly one H1 per page", pctStatus(okPages.length - badH1.length, okPages.length), badH1.length ? `${badH1.length} pages off` : "", "h1", "Use one descriptive H1 per page.", "Core SEO Monitoring");
    check("content_depth", "onpage", 2, "Content depth (≥300 words)", pctStatus(okPages.length - thin.length, okPages.length, 0.8, 0.5), thin.length ? `${thin.length} thin pages` : "", "page_copy", "Expand thin pages with genuinely useful, locally-relevant copy.", "Content Recommendations", "content");
    check("img_alt", "onpage", 2, "Images have alt text", pctStatus(okPages.length - noAlt.length, okPages.length), noAlt.length ? `${noAlt.length} pages with missing alts` : "", "image_alt", "Add descriptive alt text to all meaningful images.", "Core SEO Monitoring");
    check("og_tags", "onpage", 1, "Open Graph tags complete", homeHtmlRaw ? B(ogComplete) : "na", ogComplete ? "" : "og:title / og:description / og:image incomplete", "og_tags", "Add og:title, og:description and og:image so shares render rich cards.", "Schema Implementation");
    check("twitter_card", "onpage", 1, "Twitter/X card tag", homeHtmlRaw ? B(twitterCard) : "na", "", "og_tags", "Add a twitter:card meta tag.", "Schema Implementation");
    check("canonical_self", "onpage", 2, "Canonical tag is self-referencing", homeHtmlRaw ? B(canonicalSelf) : "na", canonicalHref ? (canonicalSelf ? "" : `canonical → ${canonicalHref}`) : "no canonical tag", "canonical", "Add a self-referencing canonical link to every indexable page.", "Schema Implementation");
    check("url_quality", "onpage", 1, "Clean URL structure", okPages.length ? pctStatus(okPages.length - badUrls.length, okPages.length) : "na", badUrls.length ? `${badUrls.length} URLs with uppercase/underscores/params` : "", null, "Use short, lowercase, hyphenated URLs going forward (301 old ones).", "Domain Optimization (404 fixes, 301 redirects)");
    check("internal_links", "onpage", 1, "Internal linking to target pages", oppKws.length ? "warn" : "pass", oppKws.length ? `${oppKws.length} near-miss keywords need internal-link support` : "", "internal_link", "Add contextual internal links toward the near-miss pages.", "Internal Link Strategy");

    // SCHEMA / STRUCTURED DATA
    check("schema_org", "schema", 2, "Organization schema", B(allSchema.has("Organization") || allSchema.has("LocalBusiness")), "", "org_schema", "Add Organization JSON-LD with logo + sameAs profiles.", "Schema Implementation");
    check("schema_local", "schema", 3, "LocalBusiness schema", B(allSchema.has("LocalBusiness")), "", "local_business_schema", "Add LocalBusiness JSON-LD with NAP, geo, hours and areaServed.", "Schema Implementation");
    check("schema_faq", "schema", 2, "FAQPage schema", B(hasFAQ), "", "faq_schema", "Add FAQPage JSON-LD answering real customer questions.", "Schema Implementation");
    check("schema_breadcrumb", "schema", 1, "BreadcrumbList schema", B(allSchema.has("BreadcrumbList")), "", "breadcrumb_schema", "Add BreadcrumbList JSON-LD sitewide.", "Schema Implementation");
    check("schema_rating", "schema", 2, "AggregateRating schema", B(allSchema.has("AggregateRating")), "", "aggregate_rating_schema", "Mark up real reviews with AggregateRating.", "Schema Implementation");
    check("schema_website", "schema", 1, "WebSite schema (+SearchAction)", B(allSchema.has("WebSite")), "", "website_schema", "Add WebSite JSON-LD for a clean brand entity and sitelinks searchbox.", "Schema Implementation");

    // AEO (answer engines / AI assistants)
    check("aeo_faq", "aeo", 3, "FAQ/answer content exists", B(hasFAQ), "", "faq_schema", "Publish FAQ content with FAQPage markup on the money pages.", "AEO Research & Optimization", "content");
    check("aeo_qheads", "aeo", 2, "Question-formatted headings", questionHeads >= 3 ? "pass" : questionHeads >= 1 ? "warn" : "fail", `${questionHeads} question headings found`, null, "Add H2/H3s phrased as real customer questions with direct answers.", "AEO Research & Optimization", "content");
    check("aeo_llms", "aeo", 1, "llms.txt for AI crawlers", B(llmsTxt), "", "llms_txt", "Publish /llms.txt describing the business, services and key pages for AI assistants.", "AEO Research & Optimization");
    check("aeo_sameas", "aeo", 2, "Entity sameAs profile links", homeHtmlRaw ? B(/"sameAs"/.test(homeHtmlRaw)) : "na", "", "org_schema", "Link the brand's profiles (GBP, Facebook, LinkedIn, …) via sameAs in Organization schema.", "Schema Implementation");
    check("aeo_snippets", "aeo", 2, "Featured-snippet capture", snippetKws.length ? (snippetWon.length ? "pass" : "fail") : "na", snippetKws.length ? `${snippetWon.length}/${snippetKws.length} captured` : "", null, "Structure direct 40–60 word answers at the top of ranking pages.", "AEO Research & Optimization", "content");
    check("aeo_overviews", "aeo", 3, "AI Overview citation", aiOverviewKws.length ? (aiCaptured.length ? "pass" : "fail") : "na", aiOverviewKws.length ? `${aiCaptured.length}/${aiOverviewKws.length} captured` : "", null, "Publish quotable, declarative answer paragraphs AI can cite.", "AEO Research & Optimization", "content");
    check("aeo_sov", "aeo", 3, "AI share of voice vs competitors", brandRadar ? ((brandRadar.ourSov || 0) >= (brandRadar.topCompetitor?.sov || 0) && brandRadar.mentions > 0 ? "pass" : brandRadar.mentions > 0 ? "warn" : "fail") : "na", brandRadar ? `SoV ${((brandRadar.ourSov || 0) * 100).toFixed(0)}%, ${brandRadar.mentions} mentions` : "", null, "Grow citable content + entity signals until AI mentions lead the market.", "AEO Research & Optimization", "content");

    // E-E-A-T / TRUST
    check("eeat_about", "eeat", 2, "About/team story present", B(!!eeat.hasAbout), "", null, "Publish an About page with the real team, story and service area.", "Content Recommendations", "content");
    check("eeat_credentials", "eeat", 2, "Credentials/trust language", B(!!eeat.hasCredentials), "", null, "State licenses, certifications, awards and years in business.", "Content Recommendations", "content");
    check("eeat_reviews", "eeat", 2, "Review signals on-site", B(!!eeat.hasReviews), "", "aggregate_rating_schema", "Surface real testimonials with review markup.", "Reputation Monitoring");
    check("eeat_person", "eeat", 2, "Named people (Person schema)", B(!!eeat.hasPerson), "", "person_schema", "Add owner/expert bios with Person JSON-LD + sameAs.", "Schema Implementation");
    check("eeat_privacy", "eeat", 1, "Privacy/legal page linked", homeHtmlRaw ? B(privacyLink) : "na", "", null, "Link a privacy policy in the footer.", "Site Health Scan");
    check("eeat_contact", "eeat", 1, "Contact page linked", homeHtmlRaw ? B(contactLink) : "na", "", null, "Link a contact page with full NAP.", "Site Health Scan");

    // LOCAL
    check("local_nap", "local", 3, "NAP on the homepage", B(!!hasNAP), homePage?.nap?.hasPhone && !hasNAP ? "phone found, address missing" : "", "local_business_schema", "Add consistent name/address/phone in the footer + LocalBusiness schema.", "Local Listing Optimization");
    check("local_schema", "local", 2, "LocalBusiness schema", B(allSchema.has("LocalBusiness")), "", "local_business_schema", "Add LocalBusiness JSON-LD with geo + hours.", "Schema Implementation");
    check("local_pack", "local", 3, "Local-pack presence", (localPackKws.length || serpLocal.length) ? (localPackWon.length ? "pass" : "fail") : "na", localPackWon.length ? `${localPackWon.length} keywords in the pack` : "competitors hold the pack", null, "Optimize the Business Profile: categories, photos, reviews, weekly posts.", "GBP Management & Posting");
    check("local_intent", "local", 2, "Ranking for local-intent terms", localIntentKws.length >= 3 ? "pass" : localIntentKws.length ? "warn" : "fail", `${localIntentKws.length} local-intent keywords ranked`, null, "Build '[service] [city]' landing pages across the trade area.", "Targeted Landing Pages (up to 5)", "content");
    check("local_tel", "local", 1, "Click-to-call tel: link", homeHtmlRaw ? B(telLink) : "na", "", null, "Make the phone number a tap-to-call tel: link.", "Local Listing Optimization");
    check("local_map", "local", 1, "Map/GBP presence on site", homeHtmlRaw ? B(mapPresence) : "na", "", null, "Embed the Google map / link the Business Profile.", "Local Listing Optimization");
    check("local_geo_pages", "local", 2, "Trade-area town coverage", geoList.length > 1 ? (townCovered ? "pass" : "warn") : "na", townCovered ? "" : `no pages target the ${secondaryTowns.length} secondary towns`, null, "Publish a landing page per secondary town × top service.", "Targeted Landing Pages (up to 5)", "content");

    // ── PILLAR + COMPOSITE SCORES (all derived from the checklist) ────────────
    const pillarScore = (p: string): number | null => {
      const rows = CL.filter((c) => c.pillar === p && c.status !== "na");
      if (!rows.length) return null;
      const poss = rows.reduce((a: number, c: any) => a + c.weight, 0);
      const earned = rows.reduce((a: number, c: any) => a + (c.status === "pass" ? c.weight : c.status === "warn" ? c.weight / 2 : 0), 0);
      return Math.round((earned / poss) * 100);
    };
    // Integrity rule: a one-page sample cannot support an A-grade technical
    // claim. Without a crawl the technical score is capped and says why.
    let techScore = pillarScore("technical") ?? 0;
    if (!crawlUsed && !sitemapCrawled && techScore > 79) { techScore = 79; note.push("Technical score capped at 79 — no crawl configured, findings are sampled."); }
    const perfScore = pillarScore("performance");
    const onpageScore = pillarScore("onpage") ?? 0;
    const schemaScore = pillarScore("schema") ?? 0;
    const aeoScore = pillarScore("aeo") ?? 0;
    const eeatScore = pillarScore("eeat") ?? 0;
    const localScore = pillarScore("local") ?? 0;
    const PILLAR_WEIGHT: Record<string, number> = { technical: 20, performance: 15, onpage: 20, schema: 10, aeo: 15, eeat: 10, local: 10 };
    const pillarVals: Record<string, number | null> = { technical: techScore, performance: perfScore, onpage: onpageScore, schema: schemaScore, aeo: aeoScore, eeat: eeatScore, local: localScore };
    let _w = 0, _s = 0;
    Object.entries(pillarVals).forEach(([p, v]) => { if (v != null) { _w += PILLAR_WEIGHT[p]; _s += v * PILLAR_WEIGHT[p]; } });
    const auditScore = _w ? Math.round(_s / _w) : 0;

    const grades = { grade_technical: grade(techScore), grade_onpage: grade(onpageScore), grade_schema: grade(schemaScore), grade_aeo: grade(aeoScore), grade_eeat: grade(eeatScore), grade_local: grade(localScore) };
    const grade_performance = perfScore == null ? null : grade(perfScore);

    // ── 12. FINDINGS ENGINE ───────────────────────────────────────────────────
    const FN: any[] = [];
    const add = (severity: string, engine: string, title: string, recommended_fix: string, goal: string) => FN.push({ severity, engine, title, recommended_fix, goal });

    // TECHNICAL — from crawl issues when available, else fetch checks.
    if (crawlUsed && crawlIssues.length) {
      const sevMap: Record<string,string> = { Error: "high", Warning: "medium", Notice: "low" };
      crawlIssues.sort((a: any, b: any) => (b.crawled||0)-(a.crawled||0)).slice(0, 15).forEach((i: any) => {
        const sev = i.importance === "Error" && i.crawled >= 5 ? "critical" : (sevMap[i.importance] || "low");
        add(sev, "fix", `${i.name} — ${i.crawled} page${i.crawled>1?"s":""} (${i.category})`, `Resolve the "${i.name}" issue across affected pages.`, "Fix crawl/indexation problems found in the full-site crawl.");
      });
    } else {
      if (homePage && !homePage.ok) add("critical","audit",`Homepage returned HTTP ${homePage.status||"error"}`,"Restore a 200 response.","A crawlable homepage is the baseline for ranking.");
      if (homePage?.ok && !homePage.https) add("critical","fix","Site is not served over HTTPS","Install/repair SSL and force HTTPS.","HTTPS is a baseline trust/ranking signal.");
      if (homePage?.ok && !homePage.viewport) add("high","fix","No mobile viewport tag","Add a responsive viewport meta tag.","Mobile-friendliness is required.");
      if (!sitemapOk) add("medium","fix","No XML sitemap found","Generate and submit an XML sitemap.","Help Google discover every page.");
      if (!robotsOk) add("high","fix","robots.txt may be blocking the site","Review robots.txt for an over-broad Disallow.","Ensure the site is crawlable.");
      add("low","audit","Deep crawl not configured","Set up a crawl project for this domain for full-site technical coverage.","Audit every page, not just a sample.");
    }

    // SCHEMA
    EXPECT_SCHEMA.forEach((t) => { if (!(allSchema.has(t) || (t === "Organization" && allSchema.has("LocalBusiness")))) {
      const sev = (t === "LocalBusiness" || t === "FAQPage") ? "high" : t === "AggregateRating" ? "medium" : "low";
      add(sev, "fix", `Missing ${t} structured data`, `Add ${t} JSON-LD and validate with the Rich Results Test.`, "Structured data powers rich results and AI comprehension."); } });

    // ON-PAGE — site-wide summary counts (crawl) + the worst pages.
    // (noTitle/noMeta/badH1/thin/noAlt are computed by the checklist engine above.)
    if (crawlUsed) {
      if (noTitle.length) add("medium","fix",`${noTitle.length} pages with weak/missing title tags`,"Rewrite to unique 50–60 char titles with keyword + location.","Improve rankings and click-through across the site.");
      if (noMeta.length)  add("medium","fix",`${noMeta.length} pages with missing/poor meta descriptions`,"Write 150–160 char descriptions with keyword + CTA.","Improve click-through across the site.");
      if (badH1.length)   add("low","fix",`${badH1.length} pages without a single clear H1`,"Use exactly one descriptive H1 per page.","Clear heading structure aids relevance.");
      if (thin.length)    add("medium","content",`${thin.length} thin pages (<300 words)`,"Expand with useful, locally-relevant content.","Depth supports rankings and answer eligibility.");
      if (noAlt.length)   add("low","fix",`${noAlt.length} pages with images missing alt text`,"Add descriptive alt text to all meaningful images.","Accessibility + image search visibility.");
    } else {
      okPages.forEach((p: any) => { const path = p.url.replace(/^https?:\/\/[^/]+/, "") || "/";
        if (!p.title || p.titleLen < 20) add("medium","fix",`Weak title tag on ${path}`,"Write a unique 50–60 char title with the primary keyword and location.","Titles drive rankings and click-through.");
        if (!p.metaDesc) add("medium","fix",`Missing meta description on ${path}`,"Write a 150–160 char description with keyword and CTA.","Improve click-through.");
        if (p.h1 !== 1) add("low","fix",`${p.h1===0?"No":"Multiple"} H1 on ${path}`,"Use exactly one descriptive H1.","Heading structure aids relevance.");
        if (p.words < 300) add("medium","content",`Thin content on ${path} (${p.words} words)`,"Expand with useful, locally-relevant content.","Depth supports rankings.");
      });
    }

    // AEO — SERP features + AI citation.
    if (!hasFAQ) add("high","content","No FAQ schema anywhere on the site","Add FAQPage JSON-LD answering real People-Also-Ask questions.","Win AI answers, snippets, and PAA placements.");
    if (aiOverviewKws.length && !aiCaptured.length) add("high","content",`AI Overviews appear on ${aiOverviewKws.length} of the client's keywords, none captured`,"Add concise, declarative answer paragraphs and FAQ content AI can quote.","Get cited in AI Overviews.");
    if (snippetKws.length && !snippetWon.length) add("medium","content",`Featured snippets show on ${snippetKws.length} ranked keywords, none captured`,"Structure direct answers near the top of the page.","Capture position-zero traffic.");
    if (brandRadar) {
      const ourPct = Math.round((brandRadar.ourSov||0)*100), topPct = Math.round((brandRadar.topCompetitor?.sov||0)*100);
      if (brandRadar.mentions === 0) add("critical","content","Brand is never mentioned in AI assistant answers","Build authoritative, citable content (FAQ, definitive guides, structured data) and earn mentions on trusted sites.","Become a source AI assistants cite.");
      else add("high","reporting",`Brand holds ${ourPct}% AI share of voice${brandRadar.topCompetitor?` vs ${topPct}% for ${brandRadar.topCompetitor.brand}`:""}`,"Expand citable content and entity signals to grow AI share of voice.","Close the AI-citation gap with competitors.");
      if (brandRadar.onlyCompetitors > 0 && brandRadar.mentions < brandRadar.onlyCompetitors) add("high","content",`Competitors are named in AI answers without the client ${brandRadar.onlyCompetitors}× more often`,"Target the questions where competitors are cited; publish better answers.","Displace competitors in AI responses.");
    }

    // E-E-A-T
    if (!eeat.hasReviews) add("medium","fix","No review/AggregateRating signals detected","Add structured testimonials and AggregateRating markup.","Reviews build trust and enable rating stars.");
    if (!eeat.hasPerson && !eeat.hasAbout) add("medium","content","Weak authorship / about signals","Add an authoritative About page with named people and credentials (Person schema + sameAs).","Strengthen E-E-A-T.");

    // LOCAL
    if (!hasNAP) add("high","fix","NAP not clearly present on the homepage","Add consistent NAP in header/footer and LocalBusiness schema.","Foundational for local-pack ranking.");
    if (!localIntentKws.length) add("medium","content","Not ranking for any local-intent keywords","Create location-specific service pages targeting '[service] [city]'.","Capture high-intent local searchers.");
    if (serpLocal.some((c)=>c.localPack) && !localPackWon.length) add("high","reporting",`A local pack ranks for "${serpSeed}" — competitors are in it, the client isn't`,"Optimize Google Business Profile + citations (GBP engine).","Appear in the map pack above organic results.");
    if (serpLocal.length) add("medium","reporting",`${serpLocal.length} real local competitors identified from live SERPs`,"Benchmark against these local rivals, not national sites.","Focus the strategy on who actually ranks locally.");

    // AUTHORITY / KEYWORDS / GSC
    if (referring_domains != null && referring_domains < 50) add("medium","audit",`Thin backlink profile — ${referring_domains} referring domains`,"Earn local citations and regional links.","Raise authority to compete for harder terms.");
    // BACKLINK INTEGRITY — a rock-bottom DR alongside hundreds of referring
    // domains is the signature of a toxic/spam profile or previously abused
    // domain. Material finding for the whole campaign; requires human review.
    if (domain_rating != null && referring_domains != null && domain_rating <= 5 && referring_domains >= 100) {
      add("critical","audit",`Backlink integrity mismatch — DR ${domain_rating} with ${referring_domains} referring domains`,
        "Run a backlink quality/toxicity review (and disavow if warranted) BEFORE any link building; check domain history for prior abuse.",
        "A toxic link profile suppresses every other effort — this needs human review first.");
    }
    if (linkProfile && linkProfile.lowDrPct >= 70 && (domain_rating ?? 99) <= 10)
      add("high","audit",`Backlink quality: ${linkProfile.lowDrPct}% of sampled referring domains are DR<10`,
        "Review the low-quality links (disavow if spammy) and prioritize the link-gap targets below.",
        "Weak links dilute authority; quality beats count.");
    if (linkGap.length)
      add("high","content",`${linkGap.length} link/citation opportunities — domains linking to local competitors but not the client`,
        `Pursue listings/links on: ${linkGap.slice(0, 5).map((g: any) => g.domain).join(", ")}${linkGap.length > 5 ? ", …" : ""}.`,
        "Close the local authority gap using the exact sources competitors already use.");
    if (oppKws.length) add("high","content",`${oppKws.length} keywords rank in positions 4–20 (quick wins)`,"Strengthen on-page targeting + internal links to these near-miss pages.","Push page-2 terms into the top results.");

    // TRADE-AREA OPPORTUNITY (top 3) — the high-value local terms the client doesn't own or ranks poorly for.
    opportunities.slice(0, 3).forEach((o: any) => {
      const where = o.position ? `currently ranks #${o.position}` : "not currently ranking";
      add("critical", "content", `High-value local term "${o.keyword}" (vol ${o.volume}) — ${where}`,
        `Build/strengthen a dedicated page targeting "${o.keyword}" with on-page optimization, internal links, and LocalBusiness schema.`,
        `Capture proven trade-area demand on a term that already shows commercial intent.`);
    });

    // AUTHORITY GAP vs LOCAL competitors (not vs national).
    if (medianCompDR != null && domain_rating != null && medianCompDR - domain_rating >= 5) {
      add("high", "audit",
        `Authority gap — client DR ${domain_rating} vs local-competitor median DR ${medianCompDR}`,
        `Earn local citations, regional press, supplier/partner links, and association memberships to close the DR gap.`,
        `Reach the authority threshold needed to outrank local rivals on money terms.`);
    }

    // BRANDED RELIANCE — most traffic is people typing the brand name (no real organic acquisition yet).
    if ((org_traffic || 0) > 0 && nonBrandedTraffic <= brandedTraffic) {
      const pct = Math.round((brandedTraffic / Math.max(1, org_traffic)) * 100);
      add("high", "content",
        `${pct}% of organic traffic comes from people already searching the brand name`,
        `Publish service+town landing pages and informational content targeting non-branded buyer-intent terms across the trade area.`,
        `Acquire customers who don't yet know the brand.`);
    }
    if (striking.length) add("high","content",`${striking.length} Search Console queries in striking distance (pos 5–15)`,"Prioritize on-page optimization for these proven-demand queries.","Convert existing impressions into clicks.");
    if (ctrBleed.length) add("high","fix",`${ctrBleed.length} queries get impressions but almost no clicks`,"Rewrite titles/meta for these high-impression queries.","Recover clicks the site already qualifies for.");
    if (compPages.length) add("medium","content",`Competitors win traffic with ${compPages.length} pages the client has no equivalent for`,"Build comparable, better pages for these proven topics.","Take share on topics competitors monetize.");

    // NEW-DIMENSION FINDINGS — auto-generated from the checklist for the checks
    // the legacy engine above doesn't already report (performance, security,
    // redirects, social cards, canonicals, llms.txt, trust pages, …). One
    // source of truth: fixing the check clears the finding on the next run.
    const LEGACY_COVERED = new Set([
      "https","viewport","robots_valid","sitemap_present","crawl_health",
      "schema_org","schema_local","schema_faq","schema_breadcrumb","schema_rating",
      "titles_ok","metas_ok","h1_ok","content_depth","img_alt",
      "aeo_faq","aeo_qheads","aeo_snippets","aeo_overviews","aeo_sov",
      "eeat_reviews","eeat_person","eeat_about","eeat_credentials",
      "local_nap","local_intent","local_pack","local_schema","internal_links",
    ]);
    CL.filter((c: any) => (c.status === "fail" || c.status === "warn") && !LEGACY_COVERED.has(c.id)).forEach((c: any) => {
      const sev = c.status === "warn" ? "low" : c.weight >= 3 ? "high" : c.weight === 2 ? "medium" : "low";
      add(sev, c.engine, `${c.label}${c.evidence ? ` — ${c.evidence}` : ""}`, c.action, `Pass the "${c.label}" check that third-party auditors grade.`);
    });

    // ── DIAGNOSIS ──────────────────────────────────────────────────────────────
    const worst = ([["technical",techScore],...(perfScore!=null?[["performance",perfScore]]:[]),["on-page",onpageScore],["schema",schemaScore],["AEO",aeoScore],["E-E-A-T",eeatScore],["local",localScore]] as [string,number][]).sort((a,b)=>a[1]-b[1]);
    const clFail = CL.filter((c: any) => c.status === "fail").length, clWarn = CL.filter((c: any) => c.status === "warn").length, clPass = CL.filter((c: any) => c.status === "pass").length;
    const aeoLine = brandRadar ? `Brand AI share of voice is ${Math.round((brandRadar.ourSov||0)*100)}% (mentions: ${brandRadar.mentions}).` : `AI Overviews appear on ${aiOverviewKws.length} sampled keywords${aiCaptured.length?`, ${aiCaptured.length} captured`:" — none captured"}.`;
    const diagnosis = `Audit score ${auditScore}/100 — ${clPass} checks pass, ${clWarn} warn, ${clFail} fail. ` +
      `${root} grades ${grades.grade_aeo} AEO, ${grades.grade_local} local, ${grades.grade_schema} schema, ${grades.grade_onpage} on-page, ${grades.grade_technical} technical${grade_performance?`, ${grade_performance} performance`:""}, ${grades.grade_eeat} E-E-A-T. ` +
      `Ranks for ${org_keywords ?? "—"} keywords (DR ${domain_rating ?? "—"}, ${referring_domains ?? "—"} ref domains). ${aeoLine} ` +
      `${crawlUsed?`Full-site crawl: ${pages.length} pages, health ${healthScore ?? "—"}.`:"Sampled pages only (no crawl configured)."} ` +
      `Weakest: ${worst[0][0]}. Biggest lever: ${oppKws.length?`${oppKws.length} keywords in positions 4–20 (${oppKws.slice(0,3).map((k:any)=>`“${k.keyword}” #${k.best_position}`).join(", ")})`:(hasFAQ?"AI-citation content":"FAQ/answer content for AEO")}.`;

    // ── 13. WRITE ──────────────────────────────────────────────────────────────
    // grade_performance/score need directive_engine.sql; if the live DB is
    // behind, retry without them (they're mirrored in raw either way).
    const auditRow: any = {
      client_id: client.id, domain_rating, org_keywords, org_traffic, org_keywords_top3, live_backlinks, referring_domains, diagnosis, ...grades,
      grade_performance, score: auditScore,
      raw: {
        scores: { techScore, perfScore, onpageScore, schemaScore, aeoScore, eeatScore, localScore, auditScore },
        checklist: CL,
        performance: psi,
        probes: { httpsRedirect, hostCanonical, altHost, notFoundOk, robotsFound, robotsOk, sitemapOk, sitemapDeclared, smUrls, llmsTxt, favicon,
          secMissing, mixedContent, ogComplete, twitterCard, canonicalHref, canonicalSelf, langAttr, charsetOk, analytics,
          privacyLink, contactLink, telLink, mapPresence, homeNoindex, ttfbMs, homeKB },
        business: { type: businessType, services, city },
        tradeArea: { primary: primaryCity, secondary: secondaryTowns },
        opportunities,
        authority: { client: domain_rating, medianCompetitor: medianCompDR },
        traffic: { total: org_traffic, branded: brandedTraffic, nonBranded: nonBrandedTraffic },
        coreKeywords: coreKeywords.slice(0, 20),
        crawl: { used: crawlUsed, project_id: crawlProjectId, health: healthScore, totals: crawlTotals, issues: crawlIssues.slice(0, 30) },
        aeo: { aiOverviewKws: aiOverviewKws.length, aiCaptured: aiCaptured.length, snippetKws: snippetKws.length, snippetWon: snippetWon.length, paaKws: paaKws.length, hasFAQ, questionHeads },
        backlinks: { profile: linkProfile, gap: linkGap },
        intake_suggested: intakeSuggested,
        brandRadar, serp: { seed: serpSeed, localCompetitors: serpLocal },
        local: { localIntentKws: localIntentKws.length, localPackKws: localPackKws.length, localPackWon: localPackWon.length, hasNAP },
        schema: { present: schemaPresent, all: [...allSchema] },
        onpageTotals: { noTitle: noTitle.length, noMeta: noMeta.length, badH1: badH1.length, thin: thin.length, noAlt: noAlt.length },
        pages: crawlUsed ? pages.slice(0, 40) : pages, clientTopPages, competitorPages: compPages, competitorsDetail: competitors,
        gsc: { queries: gsc.length, clicks: gscClicks, impressions: gscImpr, striking: striking.length, ctrBleed: ctrBleed.length },
        deep_sources: { site_audit_project: crawlProjectId, brand_radar_report: client.brand_radar_report_id || null },
        notes: note, errors,
      },
    };
    let { data: audit, error: aErr } = await supa.from("audits").insert(auditRow).select("id").single();
    if (aErr && /grade_performance|score|column/i.test(aErr.message || "")) {
      note.push("audits is missing the v4 columns (run directive_engine.sql) — performance/score stored in raw only.");
      delete auditRow.grade_performance; delete auditRow.score;
      ({ data: audit, error: aErr } = await supa.from("audits").insert(auditRow).select("id").single());
    }
    if (aErr || !audit) return json({ error: "failed to write audit", detail: aErr?.message, ahrefs_errors: errors }, 500);
    const audit_id = audit.id;

    if (competitors.length) await supa.from("competitors").insert(competitors.map((c: any) => ({ audit_id, domain: c.domain, domain_rating: c.domain_rating, common_keywords: c.common_keywords, total_keywords: c.total_keywords, overlap_pct: c.overlap_pct, org_traffic: c.org_traffic, is_manual: c.source === "serp_local" })));
    if (compPages.length) {
      const { data: compRows } = await supa.from("competitors").select("id, domain").eq("audit_id", audit_id);
      const idByDomain: Record<string, string> = {}; (compRows ?? []).forEach((r: any) => { idByDomain[r.domain] = r.id; });
      await supa.from("competitor_pages").insert(compPages.map((p: any) => ({ audit_id, competitor_id: idByDomain[rootOf(p.domain)] ?? null, page_path: p.url.replace(/^https?:\/\/[^/]+/, "") || "/", top_keyword: p.top_keyword, est_traffic: p.traffic })));
    }
    if (ownKw.length) await supa.from("keywords").insert(ownKw.map((k: any) => ({ audit_id, keyword: k.keyword, position: k.best_position, volume: k.volume, traffic: k.sum_traffic, is_opportunity: k.best_position != null && k.best_position >= 4 && k.best_position <= 20 })));
    if (gaps.length) await supa.from("content_gaps").insert(gaps.map((g: any) => ({ audit_id, keyword: g.keyword, competitor_domain: g.competitor_domain, their_position: g.their_position, our_position: g.our_position, volume: g.volume, difficulty: g.difficulty, intent: g.intent, selected: false })));
    if (FN.length) await supa.from("findings").insert(FN.map((f) => ({ audit_id, ...f })));

    // ── 14. FIX PLAN (capped to the most valuable pages so review stays sane) ──
    const businessCity = client.market || "";
    const kwByUrl: Record<string, string> = {}; clientTopPages.forEach((p: any) => { if (p.url) kwByUrl[p.url] = p.top_keyword || ""; });
    const primaryKw = ownKw[0]?.keyword || serpSeed || "";
    const aboutUrl = aboutGuess || home;
    const plan: any[] = [];
    const fixIds: string[] = [];
    const planFix = (kind: string, target_page: string, before_text: string, extra: Record<string, unknown> = {}) =>
      plan.push({ audit_id, kind, target_page, before_text, status: "suggested", context: { business_name: businessName, city: businessCity, target_keyword: kwByUrl[target_page] || primaryKw, ...extra } });

    okPages.slice(0, FIX_PAGE_CAP).forEach((p: any) => {
      if (!p.title || p.titleLen < 20 || p.titleLen > 65) planFix("title_tag", p.url, p.title || "");
      if (!p.metaDesc || p.metaLen < 70 || p.metaLen > 165) planFix("meta_description", p.url, p.metaDesc || "");
      if (p.h1 !== 1) planFix("h1", p.url, String(p.h1) + " H1 tag(s)");
      if (p.imgsNoAlt > 0) planFix("image_alt", p.url, `${p.imgsNoAlt} of ${p.imgs} images missing alt`, { imgs_missing: p.imgsNoAlt });
      if (p.words < 300) planFix("page_copy", p.url, `${p.words} words (thin)`);
    });
    if (!hasFAQ) planFix("faq_schema", home, "No FAQPage schema", { paa_count: paaKws.length });
    if (!allSchema.has("LocalBusiness")) planFix("local_business_schema", home, "No LocalBusiness schema");
    if (!allSchema.has("Organization") && !allSchema.has("LocalBusiness")) planFix("org_schema", home, "No Organization schema");
    if (!allSchema.has("BreadcrumbList")) planFix("breadcrumb_schema", home, "No BreadcrumbList schema");
    if (!allSchema.has("AggregateRating")) planFix("aggregate_rating_schema", home, "No AggregateRating schema");
    if (!allSchema.has("Person")) planFix("person_schema", aboutUrl, "No Person/author schema");
    if (compPages.length || gaps.length) planFix("internal_link", home, "Internal-linking opportunities from new and gap pages");
    if (brandRadar && brandRadar.mentions === 0) planFix("page_copy", home, "Build citable answer content to earn AI mentions", { aeo: true });
    // v4 kinds — one staged fix per failed site-probe check.
    if (!robotsFound || !robotsOk || !sitemapDeclared) planFix("robots_txt", home, robotsFound ? (robotsOk ? "robots.txt missing Sitemap: line" : "robots.txt blocks crawling") : "No robots.txt", { sitemap_url: sitemapUrl, current: robotsTxt.slice(0, 800) });
    if (!sitemapOk || !(smUrls || 0)) planFix("sitemap_xml", home, sitemapOk ? "Sitemap present but empty/invalid" : "No XML sitemap", { pages: okPages.slice(0, 50).map((p: any) => p.url) });
    if (httpsRedirect === false || hostCanonical === false) planFix("redirect_map", home, httpsRedirect === false ? "http:// does not redirect to https://" : `Duplicate host: ${altHost} also serves 200`, { alt_host: altHost, https_redirect: httpsRedirect, host_canonical: hostCanonical });
    if (crawlUsed && crawlIssues.some((i: any) => /4xx|404|not found|broken/i.test(String(i.name || "")))) planFix("redirect_map", home, "Broken URLs (4XX) found in the crawl", { from_crawl: true });
    if (secMissing.length) planFix("security_headers", home, `Missing: ${secMissing.join(", ")}`, { missing: secMissing });
    if (homeHtmlRaw && (!ogComplete || !twitterCard)) planFix("og_tags", home, ogComplete ? "No twitter:card tag" : "Open Graph tags incomplete", { og_title: ogTitle, og_desc: ogDesc, has_image: !!ogImage, twitter_card: twitterCard });
    if (homeHtmlRaw && !canonicalSelf) planFix("canonical", home, canonicalHref ? `Canonical points at ${canonicalHref}` : "No canonical tag");
    if (!llmsTxt) planFix("llms_txt", home, "No llms.txt for AI crawlers", { services, towns: geoList, business_type: businessType });
    if (!allSchema.has("WebSite")) planFix("website_schema", home, "No WebSite schema");
    if (!favicon) planFix("favicon", home, "No favicon detected");
    planFix("gbp_post", home, "New Business Profile post for this cycle");
    if (plan.length) {
      const { data: planRows } = await supa.from("fixes").insert(plan).select("id");
      (planRows || []).forEach((r: any) => fixIds.push(r.id));
    }

    // AUTO-WRITE EVERY FIX SERVER-SIDE. The audit decides what needs fixing;
    // the AI writes it — with no dependency on the browser staying open (the
    // old console-driven auto-write silently skipped when the tab was stale).
    let fixesDispatched = false;
    if (fixIds.length) {
      const dispatch = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-fixes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fix_ids: fixIds }),
      }).then(async (r) => { if (!r.ok) console.error("generate-fixes dispatch", r.status, (await r.text()).slice(0, 200)); })
        .catch((e) => console.error("generate-fixes dispatch", e));
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) { er.waitUntil(dispatch); fixesDispatched = true; note.push(`${fixIds.length} fixes handed to the AI writer (background).`); }
      else { fixesDispatched = true; note.push(`${fixIds.length} fixes dispatched to the AI writer.`); }
    }

    // Package row. The upsert needs unique(client_id, cycle_month) — see
    // packages_unique_key.sql. If that key is missing, DON'T fail silently
    // (that's what used to kill content generation): fall back to updating the
    // client's latest package, or plain-inserting a fresh one.
    const pkgRow = { client_id: client.id, audit_id, status: "ready", findings_count: FN.length, competitors_count: competitors.length };
    let { data: pkg, error: pErr } = await supa.from("packages").upsert(pkgRow, { onConflict: "client_id,cycle_month" }).select("id").single();
    if (pErr) {
      errors.push(`packages upsert: ${pErr.message} — run packages_unique_key.sql; using fallback`);
      const { data: existing } = await supa.from("packages").select("id").eq("client_id", client.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (existing?.id) {
        const { error: uErr } = await supa.from("packages").update(pkgRow).eq("id", existing.id);
        if (!uErr) pkg = existing; else errors.push(`packages update: ${uErr.message}`);
      }
      if (!pkg) {
        const { data: ins, error: iErr } = await supa.from("packages").insert(pkgRow).select("id").single();
        if (!iErr) pkg = ins; else errors.push(`packages insert: ${iErr.message}`);
      }
    }
    const package_id = pkg?.id ?? null;
    if (!package_id) note.push("NO PACKAGE ROW — content topics cannot queue. Fix the packages table errors above.");

    // ── 15. RECOMMENDED CONTENT (auto-created topics → drafted automatically) ──
    // Geo-bound to the trade area: a service/landing page per core money keyword
    // the client doesn't own, a dedicated landing page for each major secondary
    // town × top service, the strongest competitor gaps, and an FAQ for AEO.
    let topicCount = 0;
    let cycleMonth = 0;
    let campaignDriven = false;
    const topicsCreated: { kind: string; keyword: string; town: string | null }[] = [];
    const rejectedKw: { keyword: string; reason: string }[] = [];
    const recon = { kept: 0, retired: [] as { title: string; reason: string }[] };
    if (package_id) {
      const titleCase = (s: string) => String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
      const MODEL: Record<string, string> = { gbp_post: "haiku-4-5", blog: "sonnet-4-6", pillar: "opus-4-8", landing: "sonnet-4-6", service: "sonnet-4-6", faq: "haiku-4-5" };
      // prioritized keyword pools drawn from the live audit
      const oppKwPool = opportunities.map((o: any) => o.keyword).filter(Boolean);
      const coreUnowned = coreKeywords.filter((k: any) => !k.owned && (k.volume || 0) > 0).map((k: any) => k.keyword);
      const gapPool = gaps.map((g: any) => g.keyword).filter(Boolean);
      const townPages: string[] = [];
      services.slice(0, 3).forEach((svc: any) => secondaryTowns.slice(0, 3).forEach((t: any) => townPages.push(`${svc} ${t}`)));
      const localServices = services.slice(0, 4).map((svc: any) => primaryCity ? `${svc} ${primaryCity}` : svc);

      // ── RECONCILIATION (rule 6.1): regeneration replaces, never appends.
      // Every prior topic for this CLIENT (all cycles) claims its keyword so
      // covered intent is never regenerated. Queued/drafted pieces in THIS
      // package that fail today's gates or collide on intent are RETIRED
      // (status='retired'), never silently carried forward. Approved work is
      // always KEEP.
      const seenKeys: string[] = [];
      const takenKw = (kw: unknown) => { const key = kwKey(kw); return !key || seenKeys.some((k) => sameIntent(k, key)); };
      const claimKw = (kw: unknown) => { const key = kwKey(kw); if (key) seenKeys.push(key); };
      const usedOf: Record<string, number> = {};   // allocation usage: contract-total + "cycle:"-prefixed per-cycle
      {
        const { data: allT } = await supa.from("content_topics")
          .select("id, title, target_keyword, kind, status, package_id, packages!inner(client_id)")
          .eq("packages.client_id", client.id);
        const rows = (allT || []).filter((t: any) => t.status !== "retired")
          .sort((a: any, b: any) => (a.status === "approved" ? 0 : 1) - (b.status === "approved" ? 0 : 1));
        const toRetire: { id: string; title: string; reason: string }[] = [];
        for (const t of rows) {
          const kw = t.target_keyword || t.title || "";
          const editable = t.package_id === package_id && ["queued", "drafted", "drafting"].includes(String(t.status));
          const gate = targetRejectReason(kw, geoList);
          if (editable && gate) { toRetire.push({ id: t.id, title: t.title, reason: gate }); continue; }
          if (editable && takenKw(kw)) { toRetire.push({ id: t.id, title: t.title, reason: "duplicate intent — same searcher need as an existing piece" }); continue; }
          claimKw(kw); recon.kept++;
          usedOf[t.kind] = (usedOf[t.kind] || 0) + 1;
          if (t.package_id === package_id) usedOf["cycle:" + t.kind] = (usedOf["cycle:" + t.kind] || 0) + 1;
        }
        if (toRetire.length) {
          const { error: rErr } = await supa.from("content_topics").update({ status: "retired" }).in("id", toRetire.map((r) => r.id));
          if (rErr) {
            // NEVER report a retirement that didn't land (bug found in the
            // first shipped version: an enum/CHECK on status rejected the
            // value and the failure was invisible).
            errors.push(`RETIREMENT FAILED: ${rErr.message} — run content_status_text.sql; the ${toRetire.length} flagged pieces are still live`);
            note.push(`⚠ Reconciliation could not retire ${toRetire.length} piece(s) (${rErr.message}) — run content_status_text.sql and re-run the audit.`);
          } else {
            recon.retired = toRetire.map((r) => ({ title: r.title, reason: r.reason }));
            note.push(`Reconciliation: retired ${toRetire.length} prior piece(s) — ${toRetire.slice(0, 5).map((r) => `“${r.title}” (${r.reason})`).join("; ")}${toRetire.length > 5 ? " …" : ""}`);
          }
        }
      }

      // ── PLAN ALLOCATION CEILING (rule 6.6): never generate more of a
      // content kind than the plan funds. fixed_quantity = contract total;
      // recurring = per-cycle quantity. Static fallback mirrors the catalog.
      const tierNow = String(client.tier || "starter");
      const capOf: Record<string, { cap: number | null; perCycle: boolean }> = {};
      {
        const { data: tmplA } = await supa.from("service_templates")
          .select("content_kind, cadence_type, quantity_total, quantity_per_interval")
          .eq("tier", tierNow).eq("engine", "content").eq("active", true);
        (tmplA || []).forEach((r: any) => { if (!r.content_kind) return;
          if (r.cadence_type === "fixed_quantity") capOf[r.content_kind] = { cap: r.quantity_total ?? null, perCycle: false };
          else if (r.cadence_type === "recurring") capOf[r.content_kind] = { cap: r.quantity_per_interval ?? null, perCycle: true };
        });
        const FB: Record<string, { cap: Record<string, number>; perCycle: boolean }> = {
          blog:     { cap: { starter: 1, builder: 2, pro: 4 }, perCycle: false },
          landing:  { cap: { starter: 0, builder: 0, pro: 5 }, perCycle: false },
          gbp_post: { cap: { starter: 1, builder: 2, pro: 3 }, perCycle: true },
          pillar:   { cap: { starter: 0, builder: 0, pro: 1 }, perCycle: true },
        };
        Object.entries(FB).forEach(([k, v]) => { if (!capOf[k]) capOf[k] = { cap: v.cap[tierNow] ?? null, perCycle: v.perCycle }; });
      }
      const allocRemaining = (kind: string): number => {
        const c = capOf[kind]; if (!c || c.cap == null) return 99;
        return Math.max(0, c.cap - (c.perCycle ? (usedOf["cycle:" + kind] || 0) : (usedOf[kind] || 0)));
      };
      const consumeAlloc = (kind: string) => { usedOf[kind] = (usedOf[kind] || 0) + 1; usedOf["cycle:" + kind] = (usedOf["cycle:" + kind] || 0) + 1; };
      const allocShort: string[] = [];

      // Every candidate must clear the validation gate AND the intent registry
      // before content is generated for it; rejections are logged, never
      // silently dropped.
      const nextFrom = (...pools: string[][]): string | null => {
        for (const pool of pools) for (const kw of pool) {
          if (!kw || takenKw(kw)) continue;
          const why = targetRejectReason(kw, geoList);
          if (why) { claimKw(kw); rejectedKw.push({ keyword: kw, reason: why }); continue; }
          claimKw(kw); return kw;
        }
        return null;
      };
      const pickFor = (kind: string): string | null => {
        if (kind === "gbp_post") return nextFrom(localServices, oppKwPool, coreUnowned);
        if (kind === "blog") return nextFrom(gapPool, coreUnowned, oppKwPool);
        if (kind === "pillar") return nextFrom(oppKwPool, gapPool, coreUnowned);
        if (kind === "landing") return nextFrom(townPages, coreUnowned);
        return nextFrom(coreUnowned, oppKwPool, gapPool);
      };
      // current engagement cycle from the client's start date, clamped to the
      // contract length (contract_length_months / contract_is_evergreen on clients;
      // evergreen contracts are unclamped)
      if (client.engagement_start_date) {
        const s = new Date(String(client.engagement_start_date) + "T00:00:00Z"); const now = new Date();
        const raw = (now.getUTCFullYear() - s.getUTCFullYear()) * 12 + (now.getUTCMonth() - s.getUTCMonth()) + 1;
        const len = client.contract_is_evergreen ? 0 : (client.contract_length_months || 6);
        cycleMonth = Math.max(1, len ? Math.min(len, raw) : raw);
      }
      // the scheduled, auto content deliverables for this cycle (if a campaign is seeded)
      let due: any[] = [];
      if (cycleMonth) {
        const { data: dRows } = await supa.from("deliverables")
          .select("id, kind").eq("client_id", client.id).eq("engine", "content")
          .eq("state", "planned").eq("auto", true).eq("month_offset", cycleMonth);
        due = dRows || [];
      }
      if (due.length) {
        // CAMPAIGN-DRIVEN: one topic per scheduled content deliverable, pulled from live audit data
        campaignDriven = true;
        for (const d of due) {
          const kind = d.kind || "blog";
          if (allocRemaining(kind) <= 0) { allocShort.push(kind); continue; }
          const kw = pickFor(kind);
          if (!kw) continue;
          const town = kind === "landing" ? (secondaryTowns.find((t: any) => kw.includes(t)) || null) : (primaryCity || null);
          const { data: t, error: tErr } = await supa.from("content_topics").insert({
            package_id, title: titleCase(kw), target_keyword: kw, kind, model: MODEL[kind] || "sonnet-4-6",
            status: "queued", source: "campaign", location: town }).select("id").single();
          if (tErr) { errors.push(`content_topics: ${tErr.message}`); continue; }
          if (t?.id) { await supa.from("deliverables").update({ state: "generating", topic_id: t.id }).eq("id", d.id); topicCount++; topicsCreated.push({ kind, keyword: kw, town }); consumeAlloc(kind); }
        }
      } else {
        // FALLBACK: PLAN-FUNDED DELIVERABLES FIRST, generic recommendations
        // after. Previously blogs/pillars only appeared if the gap/keyword
        // pools happened to supply them — a Pro client could get zero of the
        // 4 contracted blogs. Now every funded content kind is queued each
        // cycle (recurring kinds at per-cycle quantity, fixed totals paced).
        const topicRows: any[] = [];
        const TOPIC_CAP = 10;
        const pushTopic = (keyword: string, kind: string, model: string, source: string, town: string | null = null) => {
          if (!keyword || takenKw(keyword) || topicRows.length >= TOPIC_CAP) return;
          const why = targetRejectReason(keyword, geoList);
          if (why) { claimKw(keyword); rejectedKw.push({ keyword, reason: why }); return; }
          if (allocRemaining(kind) <= 0) { allocShort.push(kind); return; }
          claimKw(keyword); consumeAlloc(kind);
          topicRows.push({ package_id, title: titleCase(keyword), target_keyword: keyword, kind, model, status: "queued", source, location: town });
        };
        // Blog formats that always clear the gate and invent no facts —
        // used when the gap/keyword pools can't fund the contracted blogs.
        const blogIdeas = [
          ...services.slice(0, 4).map((s: any) => `how much does ${s} cost${primaryCity ? ` in ${String(primaryCity).split(",")[0]}` : ""}`),
          ...(businessType ? [`how to choose a ${businessType}${primaryCity ? ` in ${String(primaryCity).split(",")[0]}` : ""}`] : []),
          ...services.slice(0, 2).map((s: any) => `${s} questions to ask before hiring`),
        ];
        const pace: [string, number][] = [];
        Object.entries(capOf).forEach(([kind, cc]: [string, any]) => {
          if (cc.cap == null || cc.cap <= 0) return;
          const rem = allocRemaining(kind);
          if (rem <= 0) return;
          pace.push([kind, cc.perCycle ? rem : (kind === "landing" ? Math.min(2, rem) : 1)]);
        });
        for (const [kind, n] of pace) for (let i = 0; i < n && topicRows.length < TOPIC_CAP; i++) {
          const kw = kind === "blog" ? nextFrom(gapPool, coreUnowned, blogIdeas) : pickFor(kind);
          if (!kw || allocRemaining(kind) <= 0) break;
          const town = kind === "landing" ? (secondaryTowns.find((t: any) => kw.toLowerCase().includes(String(t).split(",")[0].trim().toLowerCase())) || null) : (primaryCity || null);
          consumeAlloc(kind);
          topicRows.push({ package_id, title: titleCase(kw), target_keyword: kw, kind, model: MODEL[kind] || "sonnet-4-6", status: "queued", source: "plan", location: town });
        }
        // generic recommendations fill whatever capacity remains
        opportunities.slice(0, 2).forEach((o: any) => pushTopic(o.keyword, "service", "sonnet-4-6", "opportunity", primaryCity || null));
        coreKeywords.filter((k: any) => !k.owned && (k.volume || 0) > 0).slice(0, 3).forEach((k: any) => {
          const inf = k.intents?.informational && !k.intents?.transactional && !k.intents?.commercial;
          pushTopic(k.keyword, inf ? "blog" : "service", "sonnet-4-6", "core_keyword", primaryCity || null);
        });
        services.slice(0, 2).forEach((svc: any) => secondaryTowns.slice(0, 2).forEach((town: any) => pushTopic(`${svc} ${town}`, "landing", "sonnet-4-6", "secondary_town", town)));
        gaps.slice(0, 1).forEach((g: any) => pushTopic(g.keyword, "blog", "sonnet-4-6", "content_gap", primaryCity || null));
        if (!hasFAQ) pushTopic(coreKeywords[0]?.keyword || ownKw[0]?.keyword || serpSeed || (businessType || "services"), "faq", "haiku-4-5", "aeo", primaryCity || null);
        if (topicRows.length) { const { error: tErr } = await supa.from("content_topics").insert(topicRows); if (tErr) errors.push(`content_topics: ${tErr.message}`);
          else { topicCount = topicRows.length; topicsCreated.push(...topicRows.map((r: any) => ({ kind: r.kind, keyword: r.target_keyword, town: r.location }))); } }
      }
      if (allocShort.length) note.push(`Plan allocation ceiling reached for: ${[...new Set(allocShort)].join(", ")} — deliverables beyond the signed plan were NOT generated (recommend an upgrade or narrower scope).`);
    }

    // ── 16. DIRECTIVE — the plan-scoped work order ────────────────────────────
    // Every non-passing check becomes an ordered action item, scoped against
    // the client's plan tier: in-plan work is staged and executable; the rest
    // is an explicit upgrade recommendation with the tier that unlocks it.
    const tier = String(client.tier || "starter");
    const TIER_ORDER = ["starter", "builder", "pro"];
    // Static mirror of service_catalog.sql (fallback when the table is absent).
    const CATALOG: Record<string, string[]> = {
      "GBP Management & Posting": ["starter", "builder", "pro"],
      "Branded Blog Writing": ["starter", "builder", "pro"],
      "Local Listing Optimization": ["starter", "builder", "pro"],
      "Reputation Monitoring": ["starter", "builder", "pro"],
      "Monthly Reporting": ["starter", "builder", "pro"],
      "Radio to Video Ad": ["builder", "pro"],
      "Keyword Research & Strategy": ["builder", "pro"],
      "Site Health Scan": ["builder", "pro"],
      "High-Intent Keyword Targeting": ["builder", "pro"],
      "Content Recommendations": ["builder", "pro"],
      "Core SEO Monitoring": ["builder", "pro"],
      "Domain Optimization (404 fixes, 301 redirects)": ["builder", "pro"],
      "Internal Link Strategy": ["builder", "pro"],
      "Sitemap Refresh": ["builder", "pro"],
      "AEO Research & Optimization": ["pro"],
      "AEO Pillar Pages": ["pro"],
      "Targeted Landing Pages (up to 5)": ["pro"],
      "Schema Implementation": ["pro"],
    };
    let tierServices = new Set<string>(Object.entries(CATALOG).filter(([, ts]) => ts.includes(tier)).map(([n]) => n));
    {
      const { data: tmpl } = await supa.from("service_templates").select("name").eq("tier", tier).eq("active", true);
      if (tmpl && tmpl.length) tierServices = new Set(tmpl.map((t: any) => String(t.name)));
    }
    const stagedKinds = new Set(plan.map((f: any) => f.kind));
    const items: any[] = [];
    // One directive row per remediation: several checks can share a fix kind
    // (e.g. LocalBusiness schema appears under both schema and local pillars) —
    // count the work once, not once per pillar.
    const seenFixKind = new Set<string>();
    CL.forEach((c: any) => {
      if (c.status === "na") return;
      if (c.fix_kind) { if (seenFixKind.has(c.fix_kind)) return; seenFixKind.add(c.fix_kind); }
      const in_plan = tierServices.has(c.service);
      items.push({
        check_id: c.id, pillar: c.pillar, title: c.label, action: c.action, engine: c.engine, fix_kind: c.fix_kind,
        severity: c.status === "pass" ? "done" : c.weight >= 3 ? "high" : c.weight === 2 ? "medium" : "low",
        points: Math.max(1, Math.round(c.weight * (PILLAR_WEIGHT[c.pillar] || 10) / 10)),
        in_plan, service: c.service, unlock_tier: (CATALOG[c.service] || ["starter"])[0],
        status: c.status === "pass" ? "done" : (c.fix_kind && stagedKinds.has(c.fix_kind) && in_plan) ? "staged" : "todo",
        evidence: c.evidence || "",
      });
    });
    const CONTENT_SERVICE: Record<string, string> = { gbp_post: "GBP Management & Posting", blog: "Branded Blog Writing", pillar: "AEO Pillar Pages", landing: "Targeted Landing Pages (up to 5)", service: "High-Intent Keyword Targeting", faq: "AEO Research & Optimization" };
    topicsCreated.forEach((t) => {
      const service = CONTENT_SERVICE[t.kind] || "Content Recommendations";
      items.push({
        check_id: `content_${t.kind}_${String(t.keyword || "").replace(/\W+/g, "_").slice(0, 40)}`, pillar: "content",
        title: `${t.kind === "gbp_post" ? "GBP post" : t.kind.charAt(0).toUpperCase() + t.kind.slice(1)}: “${t.keyword}”`,
        action: `Draft, approve and publish${t.town ? ` (${t.town})` : primaryCity ? ` (${primaryCity})` : ""}.`,
        engine: "content", fix_kind: null, severity: "medium", points: 2,
        in_plan: tierServices.has(service), service, unlock_tier: (CATALOG[service] || ["starter"])[0],
        status: "staged", evidence: "",
      });
    });
    if (linkGap.length) items.push({
      check_id: "link_gap", pillar: "authority",
      title: `${linkGap.length} link/citation opportunities from competitor backlinks`,
      action: `Pursue listings/links on: ${linkGap.slice(0, 5).map((g: any) => g.domain).join(", ")}${linkGap.length > 5 ? ", …" : ""}`,
      engine: "audit", fix_kind: null, severity: "medium", points: 3,
      in_plan: tierServices.has("Local Listing Optimization"), service: "Local Listing Optimization",
      unlock_tier: "starter", status: "todo", evidence: "",
    });
    const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2, done: 3 };
    items.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || (b.points - a.points));

    // Verification loop — compare against the previous audit's checklist, flip
    // pushed fixes to "verified" when their check now passes, flag regressions.
    let progress: any = { previous_score: null, delta: null, fixed: [], regressed: [] };
    {
      const { data: prev } = await supa.from("audits").select("id, raw, run_at").eq("client_id", client.id).neq("id", audit_id).order("run_at", { ascending: false }).limit(1).maybeSingle();
      const prevCL: any[] = prev?.raw?.checklist || [];
      if (prevCL.length) {
        const prevBy: Record<string, string> = {}; prevCL.forEach((c: any) => { prevBy[c.id] = c.status; });
        const fixed = CL.filter((c: any) => c.status === "pass" && (prevBy[c.id] === "fail" || prevBy[c.id] === "warn")).map((c: any) => c.id);
        const regressed = CL.filter((c: any) => c.status === "fail" && prevBy[c.id] === "pass").map((c: any) => c.id);
        const prevScore = prev?.raw?.scores?.auditScore ?? null;
        progress = { previous_score: prevScore, delta: prevScore != null ? auditScore - prevScore : null, fixed, regressed };
        const verifiedKinds = [...new Set(CL.filter((c: any) => c.status === "pass" && c.fix_kind && (prevBy[c.id] === "fail" || prevBy[c.id] === "warn")).map((c: any) => c.fix_kind))];
        if (verifiedKinds.length && prev?.id) {
          await supa.from("fixes").update({ status: "verified", updated_at: new Date().toISOString() })
            .eq("audit_id", prev.id).eq("status", "pushed").in("kind", verifiedKinds as string[]);
        }
        if (fixed.length) note.push(`Verification: ${fixed.length} checks flipped to pass since the last audit.`);
        if (regressed.length) note.push(`REGRESSION: ${regressed.length} previously-passing checks now fail.`);
      }
    }

    const open = items.filter((i) => i.status !== "done");
    const upsell = open.filter((i) => !i.in_plan);
    const directive = {
      version: 2, built_at: new Date().toISOString(), tier, score: auditScore, target_score: 90,
      pillars: pillarVals,
      progress: { ...progress, completion_pct: items.length ? Math.round(100 * items.filter((i) => i.status === "done").length / items.length) : 0 },
      items,
      upgrade_pitch: upsell.length ? `Upgrading unlocks ${upsell.length} more fixes worth ~${upsell.reduce((a, i) => a + i.points, 0)} audit points.` : null,
      summary: `Score ${auditScore}/100 (target ${90}+). ${open.filter((i) => i.in_plan).length} in-plan actions open, ${upsell.length} available on a higher plan. The score measures completion of the graded checklist; real-world results — rankings, traffic, and AI citations — are tracked against the baseline in the monthly report.`,
    };
    if (package_id) {
      const { error: dErr } = await supa.from("packages").update({ directive }).eq("id", package_id);
      if (dErr) errors.push(`packages.directive: ${dErr.message} (run directive_engine.sql)`);
    }
    { // queryable per-check history (best-effort; needs directive_engine.sql)
      const { error: kErr } = await supa.from("audit_checks").insert(CL.map((c: any) => ({ audit_id, check_id: c.id, pillar: c.pillar, label: c.label, status: c.status, weight: c.weight, evidence: c.evidence || null, fix_kind: c.fix_kind })));
      if (kErr) errors.push(`audit_checks: ${kErr.message} (run directive_engine.sql)`);
    }
    // Keyword-gate transparency: rejections are reported, never silent.
    if (rejectedKw.length) note.push(`Keyword gate rejected ${rejectedKw.length}: ${rejectedKw.slice(0, 6).map((r) => `“${r.keyword}” (${r.reason})`).join("; ")}${rejectedKw.length > 6 ? " …" : ""}`);
    // Keep the directive readable even when packages.directive doesn't exist yet.
    await supa.from("audits").update({ raw: { ...auditRow.raw, directive, keyword_gate: rejectedKw, reconciliation: recon } }).eq("id", audit_id);

    return json({ ok: true, audit_id, package_id, cycle: cycleMonth, campaign_driven: campaignDriven, grades, grade_performance,
      score: auditScore,
      checklist: { pass: clPass, warn: clWarn, fail: clFail, total: CL.length },
      directive: { items: items.length, open: open.length, in_plan_open: open.filter((i) => i.in_plan).length, upsell: upsell.length, completion_pct: directive.progress.completion_pct },
      business: { type: businessType, services },
      trade_area: { primary: primaryCity, secondary: secondaryTowns },
      crawl: { used: crawlUsed, pages: crawlUsed ? pages.length : okPages.length, health: healthScore },
      performance: { psi: psi.score, lcp_ms: psi.lcp_ms, cls: psi.cls },
      brand_radar: brandRadar ? { sov: brandRadar.ourSov, mentions: brandRadar.mentions } : null,
      local_competitors: serpLocal.length,
      authority: { client: domain_rating, medianCompetitor: medianCompDR },
      counts: { competitors: competitors.length, competitor_pages: compPages.length, keywords: ownKw.length, core_keywords: coreKeywords.length, opportunities: opportunities.length, gaps: gaps.length, findings: FN.length, fixes: plan.length, content_topics: topicCount },
      fix_ids: fixIds, fixes_dispatched: fixesDispatched,
      reconciliation: { kept: recon.kept, retired: recon.retired.length, created: topicCount },
      notes: note, ahrefs_errors: errors });
  } catch (e) {
    console.error("run-audit fatal", e);
    return json({ error: "unhandled", detail: String(e), ahrefs_errors: errors }, 500);
  }
});
