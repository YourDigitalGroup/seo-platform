-- ── report_storage_migration.sql ──────────────────────────────────────────
-- Adds storage for the client-facing progress report on the packages row.
-- Idempotent: safe to run more than once.
ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS report_html      text,
  ADD COLUMN IF NOT EXISTS report_built_at  timestamptz;

-- Optional: store the report's structured deltas alongside the HTML for any
-- future UI that wants the raw numbers without re-parsing the HTML.
ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS report_meta      jsonb;

-- content_topics needs the geo column so the auto-write engine can geo-bind
-- secondary-town landing pages cleanly.
ALTER TABLE content_topics
  ADD COLUMN IF NOT EXISTS location text;
