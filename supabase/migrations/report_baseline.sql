-- ════════════════════════════════════════════════════════════════════════════
--  report_baseline.sql
--  The ORIGINAL ENGAGEMENT BASELINE must be immutable: re-audits create new
--  audit rows constantly (every ↻ Re-run), so "earliest audit" is not a stable
--  anchor once history is pruned or reconstructed. generate-report v2 locks the
--  baseline audit id on the client the first time it runs and never overwrites
--  it. Additive + idempotent.
-- ════════════════════════════════════════════════════════════════════════════
alter table clients add column if not exists baseline_audit_id uuid;
alter table clients add column if not exists baseline_locked_at timestamptz;
