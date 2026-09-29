# Looker Studio + TapClicks integration

Everything in the client **SEO & AEO Progress Report** (all eight sections,
every number, list, grade and plan item) is available to Looker Studio and
TapClicks. Both tools connect the same way: TapClicks' PostgreSQL connector
takes the same connection details as Looker's. A token-protected CSV feed is
the fallback for TapClicks plans without a database connector.

## What's in the data source

`supabase/migrations/looker_views.sql` creates seven read-only views.

**The progress report.** Each time a report is built, `generate-report`
2.2.0+ saves exactly what it rendered, so these views match the PDF:

| View | One row per | Covers |
|---|---|---|
| `looker_reports` | report | every headline number: program month/phase/state + summary (§1), content published, fixes deployed, schema types, audit checks passing vs baseline (§2), this cycle's counts (§3), Search Console query surface/impressions/clicks/striking distance with last-cycle and baseline (§4), ranking keywords, est. visits, domain authority with baseline and the delta notes (§5), AEO readiness %, AI citation metrics (§6), next-actions count and review flag (§8). `is_latest` marks each client's newest report. |
| `looker_report_grades` | pillar per report | §7: baseline / last cycle / now, not-assessed + coverage, regression, and the "Notes & next moves" text |
| `looker_report_items` | list line per report | every table in the report, keyed by `section`: `content_by_type`, `schema_types` (§2) · `fixes_deployed`, `content_published` (§3) · `gsc_trend`, `early_movement` (§4) · `position_improvements`, `newly_ranking` (§5) · `citation_trend` (§6) · `next_actions`, `verified_fixed`, `not_pursuing`, `roadmap` (§8) |

**Platform data** (live, not tied to a report build):

| View | One row per |
|---|---|
| `looker_audits` | audit run: score, all grades, headline metrics |
| `looker_clients` | client: roster, contract, latest score |
| `looker_content` | content piece: pipeline status |
| `looker_deliverables` | campaign deliverable: planned vs delivered per month |

Every view carries `client_id`, `client_url` and `partner_group`. Blend on
`report_id` (report views) or `client_id` (everything).

## Setup — once, in Supabase

1. **SQL Editor → paste `looker_views.sql` → Run.** Safe to re-run: it never
   resets the reader password.
2. **Redeploy `generate-report`** (2.2.0) so reports start saving snapshots.
3. **Populate every client now** instead of waiting for Monday's weekly run:
   `select seop_invoke_scheduler('weekly-reports');` in the SQL Editor.
4. **Reader password** (first time only):
   `alter role looker_reader password '…';`

## Connection details (paste into both tools)

Supabase → **Connect** (top bar) → Connection String → **Session pooler**.

| Field | Value |
|---|---|
| Connector | PostgreSQL (not MySQL) |
| Host | the pooler host, e.g. `aws-0-us-east-2.pooler.supabase.com` |
| Port | 5432 |
| Database | postgres |
| Username | `looker_reader.<project-ref>`, where the project ref is Project Settings → General → Project ID |
| Password | the looker_reader password |
| SSL | on; upload the certificate from Database → Settings → SSL Configuration (rename `.crt` → `.pem` if the picker asks for PEM) |

**Looker Studio:** Create → Data source → PostgreSQL → the above → pick a
view. **TapClicks:** Connections → PostgreSQL → the same values.

Every daily audit and weekly report build lands in the views immediately.
Looker's cache refresh defaults to 12h; set data freshness to 1h if needed.

## Whitelabel notes
- Filter each partner's dashboard on `partner_group`.
- The views exclude internal fields (keys, Trello ids, intake contact details).
  `looker_report_items` section `review_flags` is internal (strategist-review
  triggers), so leave it off client-facing dashboards.

## Fallback: the CSV feed (`report-feed` Edge Function)

For TapClicks plans without a database connector (SmartConnector pulls a URL):

1. **Deploy** `supabase/functions/report-feed/index.ts` as `report-feed`.
2. **Set the secret** `REPORT_FEED_TOKEN` to a long random string (32+ chars).
3. **Turn OFF "Enforce JWT verification"** for this one function. BI pullers
   can't send Supabase JWTs, so the token is the gate.
4. Feed URLs (treat them as secrets, since the token rides in the URL):

   `https://YOURPROJECT.supabase.co/functions/v1/report-feed?token=TOKEN&view=reports`

   - `view=` `reports` · `report_grades` · `report_items` · `audits` ·
     `clients` · `content` · `deliverables`
   - `&format=json` for JSON instead of CSV
   - `&group=Partner Name` for a per-partner feed
   - `&days=90` (audits only) for a trailing window

In TapClicks: Connections → SmartConnectors → New → URL, one per view,
fetched daily after 13:00 UTC.
