# 44i SEO Platform Connector (WordPress plugin)

A tiny, **SEO-only** connector that lets the platform push changes to a client's
WordPress site automatically — without ever touching the site's appearance.

## What it can do (and only this)
- **Content** → create a blog post / page as a **draft** (human publishes in WP).
- **SEO meta** → set SEO title, meta description, canonical (writes to Yoast or
  Rank Math's own fields). Invisible on the page.
- **Schema** → inject JSON-LD into the `<head>`. Invisible.

## What it cannot do (by design — there are no endpoints for it)
- No theme, template, CSS, layout, menu, widget, or settings changes.
- Nothing is published live without a human clicking Publish.
- Visible/technical fixes (H1, page copy, internal links, image alt) are **not**
  auto-deployed — the platform refuses them and they stay manual.

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
