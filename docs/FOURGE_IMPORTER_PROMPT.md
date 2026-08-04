# Prompt: build the 44i deploy-package importer for Fourge CMS

Copy everything below the line into the Claude Code session that works on Fourge CMS.
It specifies the exact same file format the WordPress connector consumes
(`wp-plugin/seo-platform-connector` v1.1.0 in the seo-platform repo), so one
exported file deploys to either platform.

---

Build a **44i deploy-package importer** for Fourge CMS. The 44i SEO platform
exports a single JSON file (`deploy-<site>-<date>.json`) that contains every
SEO/AEO change generated for a client site — page-level meta, JSON-LD schema,
social tags, site files, redirects, security headers, and content with
publish schedules. The WordPress connector plugin already consumes this exact
format; Fourge must consume the identical file with equivalent behavior, so
the agency uploads ONE file regardless of which CMS the client runs.

## Deliverables

1. An **admin screen** in Fourge: "SEO Platform → Import package" with a file
   upload (JSON, ≤8 MB), a **dry-run preview** (what WILL be applied/skipped),
   an **Apply** action, and an **apply report** (applied / skipped-with-reason /
   manual follow-ups). Persist the last import report.
2. An **authenticated HTTP endpoint** `POST /api/seo-platform/package` that
   accepts the same JSON body and returns the same report (Bearer token; store
   a per-site key, constant-time comparison, regenerate button in admin).
3. The **runtime output** that makes the imported data live on the site
   (head tags, served files, redirects, headers, scheduled publishing).

## The file format (format: "44i-deploy-package", format_version: 1)

```jsonc
{
  "format": "44i-deploy-package",       // reject anything else
  "format_version": 1,                   // reject greater major versions
  "generated_at": "2026-08-04T15:00:00Z",
  "site": "https://client-domain.com",   // sanity-check against the Fourge site; warn on mismatch
  "client": { "name": "…", "market": "…", "tier": "starter|builder|pro" },
  "source": { "package_id": "uuid", "audit_id": "uuid", "audit_score": 62 },

  // 1) Page-level SEO meta. target = full URL of an existing page.
  "seo_meta": [
    { "target": "https://site.com/", "seo_title": "…", "seo_description": "…", "canonical": "https://site.com/" }
  ],

  // 2) JSON-LD blocks. Multiple blocks per target are normal (Organization +
  //    LocalBusiness + FAQPage + WebSite on the homepage). jsonld is an object.
  "schema": [
    { "target": "https://site.com/", "jsonld": { "@context": "https://schema.org", "@type": "LocalBusiness" } }
  ],

  // 3) Social/OG tag blocks: raw HTML that MUST be sanitized to <meta> tags
  //    only (drop anything else, especially scripts and http-equiv).
  "og_tags": [ { "target": "https://site.com/", "html": "<meta property=\"og:title\" …>" } ],

  // 4) Site files. Serve robots.txt at /robots.txt (unless a real file exists
  //    — then skip with a reason) and llms_txt at /llms.txt (text/plain).
  //    sitemap_xml is a FALLBACK: if Fourge generates its own sitemap, skip it
  //    and note that in the report.
  "site_files": { "robots_txt": "…", "llms_txt": "…", "sitemap_xml": "…" },

  // 5) Redirects. rules[] is what you apply (301 path → URL, exact path match,
  //    trailing-slash-insensitive). raw is the .htaccess/nginx text for
  //    server-level cases — surface it as a manual follow-up, never eval it.
  "redirects": { "raw": "…", "rules": [ { "from": "/old/", "to": "https://site.com/new/", "code": 301 } ] },

  // 6) Security headers. raw contains Apache `Header always set X "Y"` and/or
  //    nginx `add_header X "Y" always;` lines. Parse name/value pairs and send
  //    them on every response (strip CR/LF from values; header-name charset
  //    [A-Za-z0-9-] only).
  "security_headers": { "raw": "…" },

  // 7) Content. THE KEY BEHAVIOR:
  //    status "schedule" + ISO date → create the page/post and publish it
  //      automatically at that time (if the date is past, publish ~now).
  //    status "draft" → create unpublished, for human review.
  //    external_id → idempotency key: re-importing the same file UPDATES the
  //      same items instead of duplicating them. Store it on the record.
  //    body_html is sanitized HTML (allow standard content tags, strip scripts).
  //    post_type "page" vs "post" → map to Fourge's equivalents.
  "content": [
    { "external_id": "uuid", "title": "…", "body_html": "<h2>…</h2><p>…</p>",
      "slug": "/network-support-cedar-rapids",      // may be null on older exports
      "seo_title": "50-60 char title tag",           // may be null
      "seo_description": "140-155 char meta",        // may be null
      "post_type": "post", "kind": "blog|landing|service|pillar|faq",
      "focus_keyword": "…", "location": "Town, ST", "approved": true,
      "status": "schedule", "schedule": "2026-08-11T09:00:00.000Z",
      "qa": ["unresolved [CLIENT TO CONFIRM] …"]     // non-empty = needs human review; refuse to publish (create as draft) until empty
    }
  ],

  // 8) Things a human must do (GBP posts, server-level items, directive
  //    tasks). Display them in the report — do not attempt to automate.
  "manual_tasks": [ { "title": "GBP post: …", "action": "…", "kind": "gbp_post" } ]
}
```

## Behavior requirements

- **Idempotent**: importing the same file twice must not duplicate anything
  (external_id for content; hash-key or replace semantics for schema/OG/meta;
  merge + dedupe for redirect rules).
- **Never fabricate success**: every item ends up in exactly one report bucket
  — applied, skipped (with a human-readable reason), or manual.
- **Target resolution**: match `target` URLs to Fourge pages by path
  (scheme/www/trailing-slash insensitive). Unresolvable targets → skipped with
  reason, never guessed.
- **Head injection**: JSON-LD as `<script type="application/ld+json">` blocks;
  OG meta tags in `<head>`; canonical as `<link rel="canonical">` if Fourge
  doesn't already manage one (if it does, set Fourge's field instead).
- **Safety**: sanitize all HTML; OG blocks reduce to `<meta>` tags only;
  redirect targets URL-validated; never execute anything from the file.
- **Scheduling**: use the CMS's native scheduled-publishing if it exists;
  otherwise a cron/queue that flips status at `schedule` time. Timezone: the
  dates are UTC ISO-8601.
- **Report shape** (also returned by the endpoint):
  `{ ok, imported_at, source: {site, generated_at}, applied: [..], skipped: [..], manual: [..] }`.

## Acceptance tests

1. Import a sample file → meta/schema/OG visible in page source, robots.txt
   and llms.txt served, redirect returns 301, headers present on responses,
   scheduled post publishes at its time, drafts sit unpublished.
2. Re-import the same file → zero duplicates, report identical.
3. Import a file with a bad target and a past schedule date → target skipped
   with reason; past-dated item publishes ~immediately.
4. Upload a non-package JSON → clean error, nothing applied.

Reference implementation (same format): the WordPress connector in the
seo-platform repo, `wp-plugin/seo-platform-connector/seo-platform-connector.php`
— mirror its semantics where Fourge has an equivalent concept.

## Phase 2 — AI auto-fix (Fourge already has Anthropic connected)

Once the importer works, add the self-healing layer the WP connector v1.2.0
ships (`seop_ai_autofix()` is the reference):

- **Fill MISSING SEO metas**: for every published page with no SEO title or
  meta description, send the site name + page title + first ~1200 chars of
  stripped content to Claude (`claude-haiku-4-5`, low max_tokens) with a
  strict JSON-only prompt: `{"title":"50-60 chars","description":"150-160
  chars with CTA"}`. Write only the missing field(s) — NEVER overwrite an
  existing value.
- **Fill missing image alts**: for pages whose content has `<img>` tags with
  no/empty `alt`, send the filenames (numbered list) and page title; get back
  a numbered list of ≤12-word alts; inject only the `alt` attribute. Mark the
  page done so re-runs skip it.
- **Batch caps per run** (e.g. 10 pages of metas + 8 pages of alts) so each
  run is cheap and fast; a **weekly scheduled run** keeps newly created pages
  covered; an authenticated **POST /api/seo-platform/ai-autofix** endpoint
  lets the platform trigger runs remotely.
- **Report** every run the same way as package imports: what was written,
  what was skipped and why. Store the last report.
- Guardrails: JSON-parse defensively (strip code fences), sanitize all AI
  output before writing, count every failure in `skipped`, and keep the
  never-overwrite rule absolute — the AI only fills gaps.
