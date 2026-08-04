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

## What it cannot do (by design)
- No theme, template, CSS, layout, menu, widget, or settings changes.
- Unapproved content is never published — it arrives as drafts; only content
  explicitly approved in the platform gets a publish schedule.
- Visible/technical fixes (H1, page copy, internal links, image alt) are **not**
  auto-deployed — the platform refuses them and they stay manual.
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
