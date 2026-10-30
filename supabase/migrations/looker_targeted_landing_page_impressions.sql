-- Exact target-slug GSC impression matches; NULL where unpublished or unmatched.
DO $$
DECLARE v text;
BEGIN
 SELECT pg_get_viewdef('public.looker_reports_monthly'::regclass,true) INTO v;
 IF position('targeted_landing_page_1_impressions' in v)>0 THEN RETURN; END IF;
 v:=replace(v,'FROM looker_reports r', ', (select sum(g.impressions)::integer from public.gsc_pages g where g.client_id=r.client_id and date_trunc(''month'',g.pulled_at)::date=r.report_month and g.pulled_at=(select max(z.pulled_at) from public.gsc_pages z where z.client_id=r.client_id and date_trunc(''month'',z.pulled_at)::date=r.report_month) and trim(trailing ''/'' from lower(split_part(g.page_url,''?'',1))) like ''%/''||regexp_replace(lower(trim(split_part(coalesce((select c.intake->>''landing_targets'' from public.clients c where c.id=r.client_id),''''),chr(10),1))),''[^a-z0-9]+'',''-'',''g'')) AS targeted_landing_page_1_impressions' ||
', (select sum(g.impressions)::integer from public.gsc_pages g where g.client_id=r.client_id and date_trunc(''month'',g.pulled_at)::date=r.report_month and g.pulled_at=(select max(z.pulled_at) from public.gsc_pages z where z.client_id=r.client_id and date_trunc(''month'',z.pulled_at)::date=r.report_month) and trim(trailing ''/'' from lower(split_part(g.page_url,''?'',1))) like ''%/''||regexp_replace(lower(trim(split_part(coalesce((select c.intake->>''landing_targets'' from public.clients c where c.id=r.client_id),''''),chr(10),2))),''[^a-z0-9]+'',''-'',''g'')) AS targeted_landing_page_2_impressions' || ' FROM looker_reports r');
 EXECUTE 'CREATE OR REPLACE VIEW public.looker_reports_monthly AS '||v;
END $$;
REVOKE ALL ON public.looker_reports_monthly FROM anon,authenticated;
GRANT SELECT ON public.looker_reports_monthly TO looker_reader;