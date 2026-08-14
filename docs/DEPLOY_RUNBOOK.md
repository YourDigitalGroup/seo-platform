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

## 1a. WordPress connector key column  (Supabase → SQL Editor)

Paste the full contents of `supabase/migrations/wp_connector.sql` and Run —
it is one idempotent line (`alter table clients add column if not exists
wp_api_key text;`). Without it, saving the WP API key in Platform Access
fails with "Could not save the key", and `publish-wp` cannot push anything.

## 1a-2. Scheduling — daily audits + weekly reports  (Supabase → SQL Editor)

First store the two Vault secrets (once):
`select vault.create_secret('https://YOURPROJECT.supabase.co', 'project_url');`
`select vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_role_key');`
Then paste `supabase/migrations/schedules.sql` and Run, and deploy the
`run-scheduled` Edge Function. Daily 11:00 UTC: audit-only re-run per active
client (rotating, 20/run, skips anything audited <20h ago). Mondays 13:00 UTC:
report rebuild per client. Verify: `select jobname, schedule from cron.job;`
Manual fire: POST /functions/v1/run-scheduled {"mode":"daily-audits"}.

## 1b. Service catalog + contract model  (Supabase → SQL Editor)

Paste the full contents of `supabase/migrations/service_catalog.sql` and Run
(idempotent; re-running syncs the seeded catalog). This creates
`service_templates` (the plan/service catalog with typed cadence, seeded from
the "New SEO Package Offerings" pricing sheet), adds
`clients.contract_length_months / contract_is_evergreen / contract_end_date`,
and adds `deliverables.cadence_type / service_template_id`.

The front-end reads `service_templates` for the deliverables checklist and
campaign seeding; until this migration runs it falls back to a built-in mirror
of the same catalog (and inserts skip the new columns), so nothing breaks —
but run it before adding clients so contracts and cadence land in the DB.

## 2. Deploy the four Edge Functions  (Supabase → Edge Functions)

For each, deploy the code from this repo (Deploy a new function → Via Editor, or
`supabase functions deploy <name>` if you install the CLI):

| Function name    | Source in repo                                  |
|------------------|--------------------------------------------------|
| `run-audit`      | `supabase/functions/run-audit/index.ts`          |
| `generate-content` | `supabase/functions/generate-content/index.ts` |
| `generate-fixes` | `supabase/functions/generate-fixes/index.ts`     |
| `generate-report`| `supabase/functions/generate-report/index.ts`    |
| `run-scheduled`  | `supabase/functions/run-scheduled/index.ts`      |
| `manage-users`   | `supabase/functions/manage-users/index.ts`       |

`manage-users` powers the console's **Team & access** panel (sidebar, visible
to Super Admins only): create users (auto-confirmed, no email round-trip),
reset passwords, change roles, remove accounts. Until it is deployed the panel
shows a "function not deployed" message. The caller's JWT is verified
server-side and the action is refused unless their `profiles.role` is
`super_admin` — regular strategists can't reach it even by calling the
function directly.

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
