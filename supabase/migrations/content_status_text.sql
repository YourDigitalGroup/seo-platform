-- ════════════════════════════════════════════════════════════════════════════
--  content_status_text.sql
--  The round-2 reconciliation engine retires superseded/junk topics by setting
--  content_topics.status = 'retired'. If that column is an enum or carries a
--  CHECK constraint from the original schema, the update fails — and in the
--  first shipped version it failed SILENTLY, so the internal review reported
--  "11 retired" while the inventory still showed every piece as drafted.
--
--  This converts the column to plain text (house style: text, no enums),
--  preserving current values, and drops any CHECK constraint on it. Idempotent:
--  converting text→text is a no-op, and the constraint drop is conditional.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare c record;
begin
  -- drop any CHECK constraint that references the status column
  for c in
    select conname from pg_constraint
    where conrelid = 'content_topics'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table content_topics drop constraint %I', c.conname);
    raise notice 'dropped CHECK constraint % on content_topics', c.conname;
  end loop;

  -- convert enum → text if needed (no-op when already text)
  if exists (
    select 1 from information_schema.columns
    where table_name = 'content_topics' and column_name = 'status' and data_type = 'USER-DEFINED'
  ) then
    alter table content_topics alter column status drop default;
    alter table content_topics alter column status type text using status::text;
    alter table content_topics alter column status set default 'queued';
    raise notice 'converted content_topics.status from enum to text';
  else
    raise notice 'content_topics.status is already text';
  end if;
end$$;
