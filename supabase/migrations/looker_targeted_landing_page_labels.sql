-- Append intake landing targets to the existing monthly report view, preserving prior fields.
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_viewdef('public.looker_reports_monthly'::regclass, true) INTO v;
  IF position('targeted_landing_pages' in v) > 0 THEN RETURN; END IF;
  v := replace(v, 'FROM looker_reports r',
    ', nullif(btrim((select c.intake->>''landing_targets'' from public.clients c where c.id=r.client_id)),'''')::text AS targeted_landing_pages' ||
    ', nullif(btrim(split_part(coalesce((select c.intake->>''landing_targets'' from public.clients c where c.id=r.client_id),''''),chr(10),1)),'''')::text AS targeted_landing_page_1' ||
    ', nullif(btrim(split_part(coalesce((select c.intake->>''landing_targets'' from public.clients c where c.id=r.client_id),''''),chr(10),2)),'''')::text AS targeted_landing_page_2' ||
    ' FROM looker_reports r');
  EXECUTE 'CREATE OR REPLACE VIEW public.looker_reports_monthly AS '||v;
END $$;
REVOKE ALL ON public.looker_reports_monthly FROM anon,authenticated;
GRANT SELECT ON public.looker_reports_monthly TO looker_reader;