-- Fixes pipeline repair. The fixes table was empty: run-audit plans 22 fix
-- kinds, but the fix_kind enum only allowed 6, so every batch insert was
-- rejected ("invalid input value for enum fix_kind"). generate-fixes also
-- writes model / last_instruction / edited_by, which fixes never had.
-- Additive and idempotent; safe to re-run.
alter type public.fix_kind add value if not exists 'h1';
alter type public.fix_kind add value if not exists 'image_alt';
alter type public.fix_kind add value if not exists 'page_copy';
alter type public.fix_kind add value if not exists 'redirect_map';
alter type public.fix_kind add value if not exists 'robots_txt';
alter type public.fix_kind add value if not exists 'sitemap_xml';
alter type public.fix_kind add value if not exists 'security_headers';
alter type public.fix_kind add value if not exists 'og_tags';
alter type public.fix_kind add value if not exists 'llms_txt';
alter type public.fix_kind add value if not exists 'favicon';
alter type public.fix_kind add value if not exists 'gbp_post';
alter type public.fix_kind add value if not exists 'local_business_schema';
alter type public.fix_kind add value if not exists 'org_schema';
alter type public.fix_kind add value if not exists 'website_schema';
alter type public.fix_kind add value if not exists 'breadcrumb_schema';
alter type public.fix_kind add value if not exists 'person_schema';
alter type public.fix_kind add value if not exists 'aggregate_rating_schema';

alter table public.fixes add column if not exists model public.content_model;
alter table public.fixes add column if not exists last_instruction text;
alter table public.fixes add column if not exists edited_by uuid references public.profiles(id) on delete set null;
create index if not exists fixes_edited_by_idx on public.fixes (edited_by);
