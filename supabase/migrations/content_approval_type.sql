-- Content approval: "Approved As Is" vs "Modified & Approved".
-- generated_body keeps the last copy the AI wrote. Writes from
-- generate-content always bump `revision` (first draft or a rewrite);
-- a strategist's save in the console changes `body` only. So the trigger
-- refreshes generated_body on insert and on every revision change, and
-- leaves it alone on human edits. At approval the console compares the
-- approved text with generated_body and records approval_type.
-- Idempotent; safe to re-run.

alter table public.content_drafts add column if not exists generated_body text;
alter table public.content_drafts add column if not exists approval_type text;
do $$ begin
  alter table public.content_drafts add constraint content_drafts_approval_type_chk
    check (approval_type is null or approval_type in ('as_is', 'modified'));
exception when duplicate_object then null; end $$;

create or replace function public.content_drafts_track_generated()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.generated_body := new.body;
  elsif new.revision is distinct from old.revision then
    -- a new AI revision: this is the copy the AI produced
    new.generated_body := new.body;
    new.approval_type := null;
  elsif new.generated_body is null then
    -- rows written before this column existed: the copy before the first
    -- human edit is the best record of what the AI produced
    new.generated_body := old.body;
  end if;
  return new;
end $$;

-- Backfill from the revision log: generate-content logs every AI revision's
-- text in content_revisions, so existing drafts get their real AI copy.
update public.content_drafts d set generated_body = r.body
from (select distinct on (draft_id, revision) draft_id, revision, body
      from public.content_revisions where body is not null
      order by draft_id, revision, created_at desc) r
where r.draft_id = d.id and r.revision = d.revision and d.generated_body is null;

drop trigger if exists content_drafts_track_generated on public.content_drafts;
create trigger content_drafts_track_generated
  before insert or update on public.content_drafts
  for each row execute function public.content_drafts_track_generated();
