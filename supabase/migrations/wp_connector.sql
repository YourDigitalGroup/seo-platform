-- ════════════════════════════════════════════════════════════════════════════
--  wp_connector.sql
--  Stores the per-client API key for the SEO Platform Connector plugin.
--  Server-side only (read by the publish-wp Edge Function). Additive/idempotent.
--  The WordPress base URL is the client's existing `url`; wp_connected already exists.
-- ════════════════════════════════════════════════════════════════════════════
alter table clients add column if not exists wp_api_key text;
