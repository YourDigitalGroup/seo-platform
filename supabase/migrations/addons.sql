-- Plan ADD-ONS — optional paid extras on top of a tier.
-- First add-on: Targeted Landing Pages ($199/mo, up to 5 pages) for the
-- Starter and Builder plans (AEO Pro already includes it).
-- Idempotent; safe to run more than once. Run AFTER service_catalog.sql.

alter table service_templates
  add column if not exists is_addon      boolean not null default false,
  add column if not exists addon_key     text,
  add column if not exists price_monthly numeric;

-- Which add-ons a client has purchased: a jsonb array of addon_key strings,
-- e.g. '["landing_pages"]'. Toggled in the console (Setup tab / add-client).
alter table clients
  add column if not exists addons jsonb not null default '[]'::jsonb;

insert into service_templates
  (tier, name, engine, content_kind, cadence_type, recurrence_interval, quantity_per_interval, quantity_total, auto, sort_order, is_addon, addon_key, price_monthly)
values
  ('starter','Targeted Landing Pages (up to 5)','content','landing','fixed_quantity',1,null,5,true,170,true,'landing_pages',199),
  ('builder','Targeted Landing Pages (up to 5)','content','landing','fixed_quantity',1,null,5,true,170,true,'landing_pages',199)
on conflict (tier, name) do update set
  is_addon = excluded.is_addon, addon_key = excluded.addon_key,
  price_monthly = excluded.price_monthly, cadence_type = excluded.cadence_type,
  quantity_total = excluded.quantity_total, active = true;
