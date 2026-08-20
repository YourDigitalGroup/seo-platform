# Looker Studio integration — strategy for Claire

Goal: the platform's audit scores, grades, roster state and content pipeline
in Looker Studio, refreshed automatically, fully whitelabel-safe.

## Recommended path: direct PostgreSQL connection (no exports, no cron)

Supabase is plain PostgreSQL, and Looker Studio has a native PostgreSQL
connector — so the report data can be LIVE with zero pipeline code.

1. **Run `supabase/migrations/looker_views.sql`** (SQL Editor). It creates
   three flattened views — `looker_audits` (scores/grades per audit run),
   `looker_clients` (roster + latest score), `looker_content` (content
   pipeline) — and a `looker_reader` role that can read ONLY those views:
   no API keys, no intake PII, no raw tables.
2. **Set the role's password**: `alter role looker_reader password '…';`
3. **Connection details** (Supabase → Settings → Database): use the
   **session pooler** host, port 5432, database `postgres`, user
   `looker_reader`. Looker Studio requires SSL — enable it in the connector.
4. In Looker Studio: *Create → Data source → PostgreSQL* → enter the above →
   pick a view. Blend the three views on `client_id` as needed.

Every audit (daily, via the scheduler) lands in the views immediately —
Looker's cache refreshes on its own schedule (default 12h, configurable to 1h).

## Whitelabel notes
- `partner_group` is on every row — filter each partner's Looker report to
  their own group and brand the report theme to them.
- The views deliberately exclude 44i-internal fields (keys, Trello ids,
  intake contact details).

## Alternative if IT blocks direct DB access
Schedule a weekly CSV export (a small Edge Function can serve
`looker_audits` as CSV behind a token) and use Looker's file upload — but
prefer the live connection; it is less machinery and always current.
