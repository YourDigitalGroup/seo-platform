-- Advice Local (LLO fulfillment) linkage — advice-local Edge Function.
-- Remembers the Advice Local business-location id and LLO order id per
-- client, so syncs are idempotent (create once, update thereafter) and a
-- billable order can't be placed twice by accident.
-- Idempotent; safe to run more than once.

alter table clients
  add column if not exists al_client_id bigint,
  add column if not exists al_order_id  bigint,
  add column if not exists al_synced_at timestamptz;
