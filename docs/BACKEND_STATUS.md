# Backend status & inventory

Last reconciled: 2026-06-22. This repo's live artifact is `index.html` (FTP-deployed
on push to `main`). The backend (Supabase Edge Functions + SQL) is **not** part of the
deployed site and is excluded from the FTP action.

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
