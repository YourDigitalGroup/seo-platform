# Backend status & inventory

Last reconciled: 2026-06-22. This repo's live artifact is `index.html` (FTP-deployed
on push to `main`). The backend (Supabase Edge Functions + SQL) is **not** part of the
deployed site and is excluded from the FTP action.

## 2026-08-10 — Connector v1.3.0 + V5.1.1 (schema everywhere, E-E-A-T, local, media alts)

Re-zip the connector (v1.3.0) and update it on client sites. Console V5.1.1
adds the `business` section to the deploy file (from approved intake + audit
trade area) — older deploy files still import fine, they just don't feed the
schema engine.

- **Site-wide schema engine** (connector, `wp_head` @21): correct JSON-LD on
  EVERY page from real data only — WebSite(+SearchAction), LocalBusiness
  (NAP/hours/areaServed/sameAs/hasMap from package business facts; minimal
  Organization when absent), WebPage, BreadcrumbList (post ancestors), and
  BlogPosting with real author Person → worksFor org (E-E-A-T). Types already
  imported for the page — or printed by Yoast/Rank Math — are skipped, never
  duplicated. `geo.placename`/`geo.region` meta on every page.
- **Media-library alt sweep** (AI auto-fix step 3): fills missing
  `_wp_attachment_image_alt` (20/run, never overwrites) with deterministic
  filename fallback — covers theme/builder-placed images that in-content
  alt fixes can't reach.
- **Regression guardrails** (why a deployed package could LOWER the score):
  imported body `<h1>` demoted to `<h2>` (theme title is the page's one H1 —
  imports were creating double-H1 pages, failing the single-H1 check on every
  new page), and `Content-Security-Policy` is never auto-applied (a wrong CSP
  breaks rendering + PageSpeed) — moved to the manual follow-up list.
- **Outbound HTTP unblock**: connector defines `WP_HTTP_BLOCK_EXTERNAL=false`
  when wp-config hasn't (44i hosting blocks outbound HTTP by default; the AI
  auto-fix needs api.anthropic.com). Scott had hand-patched this on a live
  site; now in the repo.

## 2026-08-10 — V5.1.0 re-audit, audit history, WP key field

Redeploy `run-audit`. No migration required (uses existing `audits`,
`audit_checks`, `clients.wp_api_key`).

- **Audit-only re-runs** (run-audit): `{ client_id, audit_only: true }`
  re-measures and rescores the site WITHOUT rebuilding the campaign — no new
  fixes staged, no content topics, no package regeneration. The existing fix
  queue is carried forward to the fresh audit (so the console keeps showing
  it), the verification loop still flips pushed fixes to `verified`, and the
  response reports `progress` (previous score, delta, fixed/regressed counts).
  The latest package is re-pointed at the new audit; report/topics untouched.
- **Console ↻ Re-run audit** (tab ②): one click after deploying to log the
  movement; toast shows the new score, the delta, and verified checks.
- **Audit History** (tab ②): every audit run is charted (score 0–100 over
  time, dashed target-90 line) with a newest-first table — date, score, Δ,
  pillar grades, DR, keywords, organic traffic. Data was always stored
  (each run inserts an `audits` row); the console now shows it.
- **Platform Access WP key field**: the WordPress card now has the paste
  field for the connector plugin's API key the instructions referenced —
  saves `clients.wp_api_key` + `wp_connected`, shows `····last4` once saved,
  with Replace. `publish-wp` needs this key to push anything.

## 2026-08-04 — V2.0.0 hardening (delivery-QA critique implemented)

Code gates, not prompt requests (a filter can't be talked out of rejecting
"ia"). Redeploy `run-audit`, `generate-content`, `generate-fixes`; re-zip the
connector (v1.2.1).

- **Keyword validation gate** (run-audit): rejects bare state codes/names,
  ZIPs, single-word/near-me/bare-town targets before any content is
  generated; every rejection is logged to `audits.raw.keyword_gate` + notes.
- **Fact provenance** (generate-content + generate-fixes): hard prompt wall —
  no testimonials/reviews ever (FTC rule), no invented certifications, years,
  SLAs, tools, pricing, or "24/7" claims; unknown facts become
  `[CLIENT TO CONFIRM: …]` tokens; no `[phone number]`-style placeholders.
- **Publish-complete content**: every draft opens with SLUG / TITLE TAG /
  META DESCRIPTION / H1; FAQ blocks (40–60-word standalone answers) required
  per kind; geo landings must be town-specific (anti-doorway) — no shared H2
  skeletons; GBP posts locked to 100–300 words plain text.
- **Console QA gate** (V2.0.0): drafts with unresolved CONFIRM tokens,
  placeholders, or testimonial patterns cannot be approved; deploy-file
  content items carry parsed slug/seo_title/seo_description + a `qa` array;
  campaign doc gains an executive summary, status key, content summary table
  with full drafts moved to Appendix A, and a red INTERNAL REVIEW banner when
  QA issues exist. Draft save/approve now persist to content_drafts.
- **Audit integrity** (run-audit): technical score capped at 79 without a
  crawl (+ new crawl_coverage check), DR-vs-referring-domains mismatch flagged
  as a critical toxic-backlink finding, directive rows deduped by fix kind,
  "biggest lever" names its keywords, honest directive summary (checklist
  score ≠ visibility; baseline-tracked outcomes in the report).
- Connector v1.2.1: content items apply `slug`, `seo_title`,
  `seo_description`; LocalBusiness scaffold gains stable `@id`, geo, hours,
  sameAs.

## 2026-08-04 — One-file deploy package (V1.7.0, connector v1.1.0)

- `index.html` V1.7.0: **⬇ Deploy file (.json)** button in the package hero
  exports a `44i-deploy-package` file containing everything generated: SEO
  meta, JSON-LD, OG tags, robots.txt/llms.txt/sitemap fallback, parsed 301
  rules, security headers, content with weekly publish schedules (approved →
  scheduled, unapproved → drafts), and manual tasks (GBP posts, directive
  items). `generatePackage()` remains the single generate-everything action
  and now ends with a completion toast.
- WP connector **v1.1.0**: Settings → SEO Platform → **Import package**
  (file upload) + REST `POST /package`. Applies the whole file with an
  applied/skipped/manual report; scheduled posts use native `future` status;
  robots.txt via filter, llms.txt served at /llms.txt, redirects + security
  headers at runtime; idempotent re-imports. Re-zip and update the plugin on
  client sites to get the importer.
- `docs/FOURGE_IMPORTER_PROMPT.md`: paste-ready prompt + full format spec for
  building the identical importer into Fourge CMS.

## 2026-07-20 — v4 "Directive Engine" (V1.5.0)

The audit is now an exhaustive, weighted checklist + plan-scoped directive:

- `run-audit` v4: ~55 deterministic checks covering the union of what
  Lighthouse/PageSpeed, Ahrefs, SEMrush, Moz and the popular SEO checkers grade
  (HTTPS + redirect chain, host canonicalization, robots/sitemap validation,
  soft-404s, security headers, mixed content, Core Web Vitals via the free
  PageSpeed API, duplicate titles/metas, OG/Twitter cards, canonical
  self-reference, favicon, lang/charset, analytics, llms.txt, entity sameAs,
  trust pages, NAP/GBP/tel/map signals, trade-area town coverage). All pillar
  scores derive from the checklist; a new **performance** pillar and a
  composite 0-100 **audit score** are added. Every non-passing check maps to a
  fix kind + the plan service that covers it → compiled into a **directive**
  (in-plan items staged, out-of-plan items shown as upgrade recommendations
  with the unlocking tier). Re-audits diff the checklist, flip pushed fixes to
  `verified` when their check passes, and report fixed/regressed checks.
- New fix kinds in `generate-fixes`: `robots_txt`, `sitemap_xml`, `canonical`,
  `security_headers`, `redirect_map`, `favicon` (deterministic),
  `website_schema` (JSON-LD scaffold), `llms_txt`, `og_tags` (AI-written).
- New migration **`directive_engine.sql`**: `audits.grade_performance`,
  `audits.score`, `packages.directive`, `audit_checks` table. The functions
  degrade gracefully pre-migration (everything mirrored into `audits.raw`).
- New optional secret: `PAGESPEED_API_KEY` (PageSpeed works unkeyed at low
  volume; the key removes rate limits). Deploy: redeploy `run-audit`,
  `generate-fixes`, `publish-wp`; run `directive_engine.sql`.
- `index.html` V1.5.0: audit-score + performance tiles, **Plan Directive**
  panel (tier-scoped work order with progress toward 90+), collapsible
  per-pillar checklist, labels for the new fix kinds and `verified` status.

## Repo layout

```
index.html                         front-end SPA (deployed to the live site via FTP)
supabase/functions/<name>/index.ts Edge Functions (deploy via Supabase dashboard or CLI)
supabase/migrations/*.sql          schema migrations (run in the Supabase SQL editor)
docs/sample-reports/*.html         example client progress reports (reference only)
```

## Version-controlled here (verified copies)

- `supabase/functions/run-audit/index.ts` — six-pillar audit + remediation planner (trade-area build)
- `supabase/functions/generate-content/index.ts` — writes a content draft for a queued topic
- `supabase/functions/generate-fixes/index.ts` — writes the deployable artifact for a staged fix
- `supabase/functions/generate-report/index.ts` — builds the client-facing progress report
- `supabase/migrations/report_storage_migration.sql`

All four functions transpile cleanly (esbuild syntax check, 2026-06-22).

## NOT yet backed up — only live in Supabase

These were built/deployed in earlier sessions and have no source here. Recover by
copying the deployed code out of the Supabase dashboard (Edge Functions / migration
history) into this repo:

- Functions: `pull-gsc`, `seed-roadmap`
- SQL: `schema.sql` (full schema), `seed_groups.sql`, `remediation_migration.sql`,
  `roadmap_migration.sql`, the GSC table/multi-account migrations, the grants + staff/users seed

## Known issue — code expects schema the live DB does not have

A live schema dump (information_schema) shows the database is **behind** the final
functions. Inserts/queries against missing columns fail silently, which is why fixes
never stage, content never queues, and the report comes back empty.

| Function expects | Live DB actually has | Symptom |
|---|---|---|
| `fixes.audit_id`, `fixes.status`, `fixes.context`, `fixes.updated_at` | `fixes` has `package_id`, `applied` (old shape) | no technical fixes staged |
| `content_topics.location` | column absent | no content topics created |
| `packages.report_html` / `report_built_at` / `report_meta` | columns absent | report storage fails |

`report_storage_migration.sql` adds the `packages.*` + `content_topics.location` columns.
A `remediation_migration` to evolve `fixes` (add `audit_id`, `status`, `context`,
`updated_at`) was described in design but never applied — it still needs to be written
to match exactly what the functions reference, then run.

**Reconciliation = apply the missing migrations so the DB matches the deployed code.**

## Front-end gap

The committed `index.html` is an older build (scorecard + remediation UI) and is
**missing** the trade-area UI, opportunity/keyword table, and the client report bar that
the final build added. The verified final `index.html` (168 KB) exists outside the repo;
swapping it in is the "catch the live site up" step. The 6-month roadmap UI was never
built.
