# Looker Studio + TapClicks integration

Two ways out of the platform, both fed by the same four reporting views
(`looker_views.sql`): a **live PostgreSQL connection** (best for Looker
Studio) and a **token-protected CSV feed** (best for TapClicks, and the
fallback for Looker when direct DB access is blocked). TapClicks setup is at
the bottom.


Goal: the platform's audit scores, grades, roster state and content pipeline
in Looker Studio, refreshed automatically, fully whitelabel-safe.

## Recommended path: direct PostgreSQL connection (no exports, no cron)

Supabase is plain PostgreSQL, and Looker Studio has a native PostgreSQL
connector — so the report data can be LIVE with zero pipeline code.

1. **Run `supabase/migrations/looker_views.sql`** (SQL Editor). It creates
   four flattened views — `looker_audits` (scores/grades per audit run),
   `looker_clients` (roster + latest score), `looker_content` (content
   pipeline), `looker_deliverables` (campaign fulfillment: planned vs
   delivered per month) — and a `looker_reader` role that can read ONLY
   those views: no API keys, no intake PII, no raw tables.
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

## The CSV feed — `report-feed` Edge Function

For pullers that want a URL instead of a database (TapClicks, Sheets,
Looker-without-DB-access):

1. **Deploy** `supabase/functions/report-feed/index.ts` as `report-feed`.
2. **Set the secret** `REPORT_FEED_TOKEN` to a long random string (32+ chars;
   Edge Functions → report-feed → Secrets).
3. **Turn OFF "Enforce JWT verification"** for this one function (Edge
   Functions → report-feed → Details) — BI pullers can't send Supabase JWTs;
   the token is the gate.
4. Feed URLs (treat them as secrets — the token rides in the URL):

   `https://YOURPROJECT.supabase.co/functions/v1/report-feed?token=TOKEN&view=audits`

   - `view=` `audits` · `clients` · `content` · `deliverables`
   - `&format=json` for JSON instead of CSV
   - `&group=Partner Name` → a per-partner feed for whitelabeled dashboards
   - `&days=90` (audits only) → trailing window

## TapClicks setup (SmartConnector)

TapClicks ingests scheduled CSV pulls via SmartConnectors:

1. TapClicks → **Connections → SmartConnectors → New**, source type **URL**.
2. Paste a feed URL per view (start with `view=audits` and
   `view=deliverables`). Set the fetch schedule to daily, ~13:00 UTC — after
   the platform's 11:00 UTC audit sweep.
3. Map fields when prompted: `run_at` = date, `score` + grade columns =
   metrics, `client_url`/`partner_group` = dimensions.
4. For per-partner TapClicks clients, create one SmartConnector per partner
   using `&group=…` so each only ever sees their own rows.

SmartConnectors are a TapClicks plan feature — if the option is missing from
the menu, it needs enabling on the TapClicks subscription.
