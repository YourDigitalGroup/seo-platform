# 44i SEO Platform Connector (WordPress plugin)

A tiny, **SEO-only** connector that lets the platform push changes to a client's
WordPress site automatically — without ever touching the site's appearance.

## What it can do (and only this)
- **Content** → create a blog post / page as a **draft** (human publishes in WP).
- **SEO meta** → set SEO title, meta description, canonical (writes to Yoast or
  Rank Math's own fields). Invisible on the page.
- **Schema** → inject JSON-LD into the `<head>` (multiple blocks per page,
  site-wide blocks for the front page). Invisible.
- **v1.1 — Import package (one file deploys everything)**: upload the
  `deploy-*.json` exported by the platform's **⬇ Deploy file** button under
  **Settings → SEO Platform → Import package** (or POST it to the `/package`
  REST endpoint). In one shot it applies SEO meta, JSON-LD, OG/social tags,
  robots.txt (when WP serves it), llms.txt (served at `/llms.txt`),
  301 redirects, security headers, and creates the content — **approved
  content is scheduled** (weekly publish dates set by the platform),
  unapproved content lands as drafts. It finishes with an apply report:
  applied / skipped-with-reason / manual follow-ups (GBP posts, server-level
  rules). Re-importing the same file updates rather than duplicates
  (external-id + hash idempotency).

- **v1.2 — AI auto-fix**: with an Anthropic API key saved, fills **missing**
  SEO titles, meta descriptions, and image alt text. Never overwrites.
- **v1.3 — Site-wide schema engine**: correct JSON-LD on **every** page,
  built from real data only — `WebSite` (+SearchAction), `LocalBusiness`
  (NAP, hours, service area, GBP/social sameAs — from the deploy package's
  approved business facts), `WebPage`, `BreadcrumbList`, and `BlogPosting`
  with a real author `Person` (E-E-A-T). Types the platform already imported
  for a page — or that Yoast/Rank Math print — are skipped, never duplicated.
  Plus `geo.placename`/`geo.region` meta on every page.
- **v1.3 — Media-library alt text**: the AI auto-fix now also fills missing
  `_wp_attachment_image_alt` on library images (20 per run, filename fallback
  when the AI is unavailable), covering theme/builder-placed images.
- **v1.3 — Import guardrails**: body `<h1>` in imported content is demoted to
  `<h2>` (the theme's title is the page's one H1 — two H1s fail the audit),
  and `Content-Security-Policy` is never auto-applied (a wrong CSP breaks
  rendering and tanks PageSpeed) — it lands in the manual follow-up list.
- **v1.3 — Outbound HTTP unblock**: defines `WP_HTTP_BLOCK_EXTERNAL = false`
  (when wp-config.php hasn't already set it) so the AI auto-fix can reach
  `api.anthropic.com` on 44i-hosted sites that block outbound HTTP by default.

- **v1.4 — Second-pass auto-fix (the "make it all automatic" release)**:
  - Default **security headers** (HSTS on SSL, X-Content-Type-Options,
    X-Frame-Options, Referrer-Policy) always sent; package values override.
    CSP still never auto-applies.
  - AI rewrites **weak** titles/metas (outside the audit's 20–65 / 70–165
    ranges), not just missing ones. In-range values are never touched.
  - **Internal links**: the first plain-text mention of an imported page's
    focus keyword on another published page gets linked to it (never inside
    existing links, headings, buttons, or shortcodes; 10 per run; idempotent).
  - **FAQPage schema** auto-built from a page's own question-formatted
    headings (≥2 questions with real answers) — no invented Q&A, ever.
  - **llms.txt fallback** auto-generated from business facts + published
    pages when no package file exists.
  - **Privacy Policy page** created from WordPress's core template when the
    site has none (review text; link it in the footer).
  - **AggregateRating** rendered only when the package delivers real rating
    data (`business.rating_value`/`rating_count`) — never fabricated.

## What it cannot do (by design)
- No theme, template, CSS, layout, menu, widget, or settings changes.
- Unapproved content is never published — it arrives as drafts; only content
  explicitly approved in the platform gets a publish schedule.
- Visible/technical fixes (H1, page copy, internal links) are **not**
  auto-deployed — the platform refuses them and they stay manual. (Missing
  image alts are the exception: the AI auto-fix fills those, invisibly.)
- Google Business Profile posts stay manual (listed in the import report).

The same deploy-package file format is consumed by the Fourge CMS importer —
see `docs/FOURGE_IMPORTER_PROMPT.md` for the spec.

## Install (once per client site)
1. Zip the `seo-platform-connector/` folder and upload it under
   **Plugins → Add New → Upload Plugin**, then **Activate**.
2. Go to **Settings → SEO Platform**. Copy the **REST base URL** and **API key**.
3. In the platform, on that client, save the API key (stored server-side in
   `clients.wp_api_key`). The site URL is the client's existing URL.
4. The platform's `publish-wp` function calls this connector over HTTPS with the
   key as a Bearer token.

## Security
- Per-site random API key; every request is checked with a constant-time compare.
- Use HTTPS so the key isn't exposed in transit.
- Regenerate the key anytime from the settings screen.
