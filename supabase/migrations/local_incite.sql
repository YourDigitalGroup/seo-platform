-- Local Incite (Online Review Manager) as a second reputation source.
-- Idempotent; safe to re-run.

-- The client's Local Incite location (e.g. SAU1783...). Linked automatically
-- when the names match exactly, otherwise picked on the Reputation panel.
alter table public.clients add column if not exists local_incite_location_id text;

-- Which review site a review came from (Google, Facebook, Yelp...).
alter table public.reputation_reviews add column if not exists site text;

-- Source-specific numbers (Local Incite: response backlog, star breakdown,
-- reviews per site).
alter table public.reputation_snapshots add column if not exists stats jsonb;
