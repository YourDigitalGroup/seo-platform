-- ════════════════════════════════════════════════════════════════════════════
--  packages_unique_key.sql
--  run-audit upserts the package with onConflict (client_id, cycle_month), which
--  REQUIRES a unique constraint on those columns. If it's missing, the upsert
--  fails silently — no package row is created (so the UI shows "generate the
--  package first" on deploy) and no content topics get queued (package_id null).
--
--  This block is self-diagnosing and safe: it adds the constraint only if no
--  unique constraint already covers those two columns, and tells you which case
--  it hit. Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'packages'::regclass
      and contype  = 'u'
      and conkey @> (
        select array_agg(attnum)
        from pg_attribute
        where attrelid = 'packages'::regclass
          and attname in ('client_id', 'cycle_month')
      )
  ) then
    alter table packages
      add constraint packages_client_cycle_key unique (client_id, cycle_month);
    raise notice 'FIXED: added unique(client_id, cycle_month) — this was the bug.';
  else
    raise notice 'OK: a unique key on (client_id, cycle_month) already exists — look elsewhere.';
  end if;
end$$;
