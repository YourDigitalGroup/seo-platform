-- Campaign suspension — "Suspend campaign" on the package Setup tab.
-- Status becomes a plain frontend flag (active vs suspended); these two
-- columns remember when and why. The only behavioral effect is inherited:
-- run-scheduled only automates clients whose status is 'active'.
-- Idempotent; safe to run more than once.

alter table clients
  add column if not exists suspended_at   date,
  add column if not exists suspend_reason text;

-- The console writes status = 'suspended'; the enum never had that value, so
-- every "Suspend campaign" failed with "invalid input value for enum
-- client_status" (found in the 2026-10-28 QA pass).
alter type client_status add value if not exists 'suspended';

-- One-time normalization: the old onboarding/paused statuses fold into
-- 'active' so existing clients keep their scheduled audits and show under
-- the Active filter. (Nothing was ever set to 'churned' by the console.)
update clients set status = 'active'
 where status is null or status in ('onboarding', 'paused', 'churned');
