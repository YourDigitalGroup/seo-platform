-- Covering indexes for foreign keys that cascades and the console's
-- Delete-client flow walk (QA pass, 2026-10-28). Without them every deleted
-- parent row seq-scans the child table; deleting one client with ~15 audits
-- ran past the 60s statement limit. Idempotent; safe to re-run.
create index if not exists content_drafts_package_id_idx     on public.content_drafts (package_id);
create index if not exists content_drafts_topic_id_idx       on public.content_drafts (topic_id);
create index if not exists content_drafts_deliverable_id_idx on public.content_drafts (deliverable_id);
create index if not exists competitor_pages_competitor_id_idx on public.competitor_pages (competitor_id);
create index if not exists content_topics_content_gap_id_idx on public.content_topics (content_gap_id);
create index if not exists packages_audit_id_idx             on public.packages (audit_id);
create index if not exists monthly_reports_package_id_idx    on public.monthly_reports (package_id);

-- exact duplicate of deliverables_client_month_idx
drop index if exists public.deliverables_engagement_idx;
