-- Photos uploaded from the content editor (Visual mode "Image" button, paste
-- or drag-and-drop, and "Upload your own" for the featured image / GBP post
-- photo). Public read so the deploy file, Trello files and WordPress can fetch
-- them; only staff (a profiles row) can upload or delete.
-- The WordPress connector (1.14+) copies inline images into the site's own
-- media library on import, so live pages never hotlink this bucket.
-- Idempotent; safe to re-run.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('content-images', 'content-images', true, 10485760,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Staff can upload content images" on storage.objects;
create policy "Staff can upload content images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'content-images' and exists (select 1 from public.profiles where profiles.id = auth.uid()));

drop policy if exists "Staff can delete content images" on storage.objects;
create policy "Staff can delete content images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'content-images' and exists (select 1 from public.profiles where profiles.id = auth.uid()));
