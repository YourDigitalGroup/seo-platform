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
`run-scheduled` Edge Function (1.1.0 — covers the whole roster per run;
skips anything audited <20h ago). Daily 11:00 UTC: audit-only re-run per
active client. Mondays 13:00 UTC: report rebuild per client.
Verify: `select jobname, schedule from cron.job;`
Manual fire: POST /functions/v1/run-scheduled {"mode":"daily-audits"}.

**If daily audits stop running**: paste `supabase/migrations/
schedules_doctor.sql` and Run. One paste repairs the jobs, hardens the
invoker (loud failure when Vault secrets are missing, 15s HTTP timeout),
fires a run immediately, and prints a health report that names the exact
failure (missing secrets / rotated service key = 401 / function not
deployed = 404 / cron never firing). The report stays queryable afterwards:
`select * from seop_scheduler_health;`

## 1a-3. Background audit jobs  (Supabase → SQL Editor)

Paste `supabase/migrations/audit_jobs.sql` and Run (idempotent). run-audit
5.5.0+ answers the console immediately and finishes long audits in the
background — this table is where the console watches for the result. It fixes
the "HTTP 504 with no error body" failure on big sites (full crawl +
competitor discovery outliving the API gateway timeout). Requires
**redeploying run-audit** at the same time. Without the table audits still
complete (the console falls back to polling the audits list), but failures
surface with no error message.

## 1a-4. Campaign suspension  (Supabase → SQL Editor)

Paste `supabase/migrations/suspend.sql` and Run (idempotent). Adds
`clients.suspended_at / suspend_reason` for the "Suspend campaign" control on
the package Setup tab, and folds the old onboarding/paused statuses into
'active' (status is now just active vs suspended; the scheduler only
automates 'active' clients). Without it, suspending still works but the date
and reason aren't stored.

## 1a-4b. Client notes  (Supabase → SQL Editor)

Paste `supabase/migrations/client_notes.sql` and Run (idempotent). Adds
`clients.notes`: the Client Notes box on the Setup tab and the "notes" chip
on each client card. The Trello handoff card copies the notes into its
description and attaches the campaign doc (redeploy `trello`). Applied on
the live project 2026-10-16 together with `platform_extras.sql`.

## 1a-4c. WordPress AI proxy  (Supabase → SQL Editor + Edge Functions)

Paste `supabase/migrations/wp_ai_usage.sql` and Run, then deploy
`supabase/functions/wp-ai` with **Enforce JWT verification OFF** (WordPress
can't send a Supabase JWT — each site's own connector API key is the gate).
It uses the same `ANTHROPIC_API_KEY` / optional `ANTHROPIC_WORKSPACE_ID`
secrets as the other AI functions. Connector 1.10+ calls it for the AI
auto-fix, so no Anthropic key is baked into the plugin or typed on a site
(1.10 also wipes keys saved by older versions). Requirements per site: the
client is active and its connector API key is saved in Platform Access.
Guard rails: Haiku only, max 1,200 output tokens, 400 calls per site per day
(`wp_ai_usage`). Applied on the live project 2026-10-28.

## 1a-4d. Fixes pipeline repair  (Supabase → SQL Editor)

Paste `supabase/migrations/fixes_pipeline.sql` and Run (idempotent). The
`fix_kind` enum only knew 6 of the 22 fix kinds run-audit plans, so every
audit's fix batch was rejected and the fixes table stayed empty; it also
adds `fixes.model / last_instruction / edited_by`, which generate-fixes
writes. Redeploy run-audit (5.9.6: falls back to row-by-row inserts and logs
any rejected kind) and generate-fixes (checks its save). Applied on the live
project 2026-10-29. Fixes appear from the next package generation or daily
audit onward.

## 1a-4e. AI citation tracking  (Supabase → SQL Editor + Edge Functions)

Paste `supabase/migrations/ai_citations.sql`, then
`supabase/migrations/ai_citations_looker.sql`, and Run (idempotent). Deploy
`brand-radar` (new), `run-audit` (5.10.0) and `generate-report` (2.3.0).
Uses the existing `AHREFS_API_KEY`.

Every client gets an Ahrefs Brand Radar report plus a few customer questions
("best tree service in Trimont, MN") built from its services and city; new
clients are set up automatically on their first package. Ahrefs asks the
questions on the chosen AI engines; every Monday 12:40 UTC the
`seop-weekly-ai-citations` job snapshots the answers into `ai_visibility`
(questions per engine, mentions, cited pages, competitors cited) before the
13:00 report rebuild. Report section 6 and the Looker views
`looker_ai_visibility` / `looker_ai_visibility_items` read the snapshots.

Tracking is OFF by default (`app_settings.ai_tracking`). Creating reports and
questions is free; Ahrefs bills prompt checks (questions x engines x runs)
once a Super Admin turns it on in **Team & access → AI citation tracking**,
which also shows the monthly check estimate. Per client, questions are edited
on the Setup tab under Platform Access. Applied on the live project
2026-10-30; all 48 active clients have a report (the internal "Test" client
has no questions until it gets a real audit).

## 1a-4f. API keys + reputation monitoring  (Supabase → SQL Editor + Edge Functions)

Paste `supabase/migrations/platform_keys_reputation.sql` and Run (idempotent).
Deploy `platform-keys` and `reputation` (new), `run-audit` (5.11.0), and
redeploy every function that reads a key (advice-local, brand-radar,
generate-content, generate-fixes, image-search, pull-gsc, report-feed,
suggest-topics, trello, wp-ai).

**API keys.** Team & access → API keys lists every outside key the platform
uses, what it's for, which functions use it, where it comes from (set in the
console / Supabase function secret / missing), who last changed it and the
last test result. Values are never shown or returned. Replace stores the new
value encrypted in Supabase Vault (`seop_key_<NAME>`) and tests it straight
away; functions read Vault first, then the function secret, and cache for a
minute, so a rotation takes effect within a minute. Remove drops the console
copy and falls back to the secret. Only the service role can read Vault
values (`platform_key()`); every change is logged in `platform_key_events`.

**Google Places.** One Google Cloud API key with **Places API (New)**
enabled (legacy Places can't be turned on for new projects), entered as
`GOOGLE_PLACES_API_KEY`. Used by run-audit (Business Profile facts) and
reputation. Restrict the key to the Places API (New).

**Reputation.** The sidebar's Reputation page shows every active client's
Google rating, review count, 30-day change, reviews published this week and
1-2 star alerts. Each client's Setup tab has a Reputation panel with the
newest reviews, Check now, and (SA/AM) Find & pin listing. The listing is
pinned automatically when its website is the client's domain
(`clients.gbp_place_id`); otherwise it's matched by name until someone pins
it. `seop-daily-reputation` runs every day at 12:50 UTC. Google returns up to
five reviews per check; every review seen is kept in `reputation_reviews`,
each check in `reputation_snapshots`. Cost: one Place Details call (with
reviews) per client per day, about 1,500 a month for 48 clients, plus a text
search the first time an unpinned client is matched.

**Local Insight** has a key slot (`LOCAL_INSIGHT_API_KEY`, group Reputation)
but isn't wired yet; it plugs into the reputation function as a second
source once its API is documented.

## 1a-5. Plan add-ons  (Supabase → SQL Editor)

Paste `supabase/migrations/addons.sql` and Run (idempotent; AFTER
service_catalog.sql). Adds the add-on columns to service_templates and
`clients.addons`, and seeds the first add-on: **Targeted Landing Pages —
$199/mo (up to 5)** on Starter and Builder (AEO Pro includes it). Toggled per
client in the add-client modal or on the package Setup tab under the plan
picker; the audit engine only funds landing pages on Starter/Builder when the
add-on is on. Redeploy run-audit (5.8.0) with it.

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
| `advice-local`   | `supabase/functions/advice-local/index.ts`       |
| `image-search`   | `supabase/functions/image-search/index.ts`       |
| `trello`         | `supabase/functions/trello/index.ts`             |
| `report-feed`    | `supabase/functions/report-feed/index.ts`        |

`image-search` (secret: `PEXELS_API_KEY` — free from pexels.com/api) powers
the Find-image picker in the draft editor; the pick ships as the WordPress
featured image / GBP post photo. `trello` (secrets: `TRELLO_KEY`,
`TRELLO_TOKEN`; board + columns are configured in the console) powers
"Submit to SEO/AEO specialist" and approval comments. Run
`supabase/migrations/trello_settings.sql`, then in **Team & access → Trello
integration** set the Board ID, the card-title template (variables {domain}
{client} {group} {plan} {market}), and each strategist's column — "Load
board columns" lists them by name. Each user row also takes a Trello
@username so the strategist is added to the card and @mentioned. Cards get
one checklist per campaign month with that month's deliverables.
Both need `supabase/migrations/platform_extras.sql` run first (draft image
columns, topic link_target, clients.trello_card_id). For Looker Studio and
TapClicks (the full progress report — every section — plus platform data), run `looker_views.sql`, redeploy `generate-report` (2.2.0 saves the report snapshots the views read), deploy `report-feed` (secret:
`REPORT_FEED_TOKEN`, 32+ random chars; turn OFF "Enforce JWT verification"
for this one function), and see docs/LOOKER_INTEGRATION.md. Reserved for the
reputation-monitoring integration: secret `REP_MONITORING_API_KEY` (key
coming from Scott's provider).

`advice-local` is the LLO fulfillment bridge (Advice Local partner API).
Before deploying: run `supabase/migrations/advice_local.sql` (adds
`clients.al_client_id / al_order_id / al_synced_at`), then set the function
secret `ADVICE_LOCAL_API_KEY` to the partner key from Advice Local
(Edge Functions → advice-local → Secrets — never commit it to the repo).
`ADVICE_LOCAL_PRODUCT_ID` is optional and defaults to 4114 (the LLO product).
The LLO accordion on the Setup tab then gets Sync / Place order / Fulfillment
status buttons. Sync is idempotent (creates the Advice Local location once,
updates it after); the order action is billable, so it is limited to Super
Admins and Account Managers server-side and refuses to double-order a client
that already has an order id on file.

`manage-users` powers the console's **Team & access** panel (sidebar, visible
to Super Admins only): create users (auto-confirmed, no email round-trip),
reset passwords, change roles, remove accounts. It also carries the
**Remove client** action (Setup tab danger zone, Super Admins only) — a
server-side deep delete of the client and every attached record (packages,
audits & history, fixes, drafts, reports, keywords, competitors), since the
browser's anon key can't be trusted with that. Until the function is deployed
the panel shows a "function not deployed" message; after adding new actions,
redeploy it. The caller's JWT is verified server-side and every action is
refused unless their `profiles.role` is `super_admin` — regular strategists
can't reach it even by calling the function directly.

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
