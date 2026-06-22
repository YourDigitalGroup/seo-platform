# Backend status & inventory

Last reconciled: 2026-06-22. This repo's live artifact is `index.html` (FTP-deployed
on push to `main`). The backend (Supabase Edge Functions + SQL) is **not** part of the
deployed site and is excluded from the FTP action.

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
