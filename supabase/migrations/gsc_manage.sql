-- Search Console management (gsc-manage): create + verify properties, submit
-- sitemaps. Needs the Google account connected in Team & access with the full
-- Search Console + Site Verification scopes (the original connection was
-- read-only — "Reconnect" upgrades it).
-- Idempotent; safe to re-run.
alter table public.gsc_oauth_connections add column if not exists granted_scope text;

alter table public.clients add column if not exists gsc_property text;               -- e.g. https://www.example.com/ or sc-domain:example.com
alter table public.clients add column if not exists gsc_permission text;             -- siteOwner | siteFullUser | siteRestrictedUser | siteUnverifiedUser
alter table public.clients add column if not exists gsc_verification_token text;     -- google-site-verification meta content (public by design)
alter table public.clients add column if not exists gsc_sitemaps jsonb;              -- last submission: [{path, ok, error?}]
alter table public.clients add column if not exists gsc_sitemaps_submitted_at timestamptz;
alter table public.clients add column if not exists gsc_manage_error text;

-- Weekly sitemap resubmission for every active client whose property the
-- connected account owns or has full access to (Tuesdays 14:25 UTC). New
-- posts also trigger a resubmission when they go live (wp-events).
select cron.schedule('seop-weekly-gsc-sitemaps', '25 14 * * 2',
  $$select public.seop_invoke_function('gsc-manage', '{"action":"submit_all"}'::jsonb)$$);
