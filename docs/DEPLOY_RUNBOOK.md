# Deploy runbook — get the working system live

Do these in order. Steps 1–2 make the existing (backed-up) backend actually
function; step 3 brings the matching front-end live; step 4 verifies.

I (the assistant) cannot reach your Supabase project or run the FTP deploy, so
steps that touch Supabase or the live site are yours to run — but every artifact
below is in this repo and has been validated here.

## 1. Reconcile the database  (Supabase → SQL Editor)

Paste the full contents of `supabase/migrations/reconcile_schema.sql` and Run.
Expect a series of `ALTER TABLE` / `CREATE INDEX` confirmations and no errors.
(Validated against PostgreSQL 16 with the live table shapes — adds columns only,
idempotent, safe to run more than once.)

This adds: `fixes.audit_id/status/context/revision/updated_at` (+ relaxes
`fixes.package_id` to nullable), `content_topics.location`, and
`packages.report_html/report_built_at/report_meta`.

## 2. Deploy the four Edge Functions  (Supabase → Edge Functions)

For each, deploy the code from this repo (Deploy a new function → Via Editor, or
`supabase functions deploy <name>` if you install the CLI):

| Function name    | Source in repo                                  |
|------------------|--------------------------------------------------|
| `run-audit`      | `supabase/functions/run-audit/index.ts`          |
| `generate-content` | `supabase/functions/generate-content/index.ts` |
| `generate-fixes` | `supabase/functions/generate-fixes/index.ts`     |
| `generate-report`| `supabase/functions/generate-report/index.ts`    |

Secrets already set (`AHREFS_API_KEY`, `ANTHROPIC_API_KEY`, the GSC ones) carry
over; `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

## 3. Bring the front-end live

The repo's `index.html` is the final build (trade-area UI, opportunity table,
client report bar). It deploys to the live site via FTP **on push to `main`**.
To go live: merge `claude/kind-davinci-rycost` into `main` (or upload `index.html`
manually). Nothing deploys from the feature branch.

## 4. Verify end-to-end

Open a client (e.g. Save Our Space) → Generate package. You should now see:
fixes staged and auto-written, content topics queued and drafted, and the client
report build succeed — the three things that were silently failing before.

## Still to build (next)

The 6-month roadmap: make `run-audit` tier-aware (write the contracted
deliverables for the cycle instead of a generic batch) + the roadmap UI
("Month N of 6"). `seed-roadmap` + `roadmap_migration` were applied in an earlier
session (the `deliverables` columns exist) but their source isn't backed up here yet.
