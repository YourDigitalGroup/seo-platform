-- Include every stored, ranked keyword from the report's matching audit.
-- A keyword list can be smaller than the Ahrefs domain-wide keyword count.
-- Preserve all existing 29 columns and existing sections.
CREATE OR REPLACE VIEW public.looker_report_items_monthly AS
SELECT i.*, NULL::text AS al_listing_url
FROM public.looker_report_items i WHERE i.is_month_final
UNION ALL
SELECT r.report_id,r.client_id,r.client_name,r.client_url,r.plan,r.partner_group,r.report_date,
  10::integer,'advice_local_directory'::text,
  row_number() OVER (PARTITION BY r.report_id ORDER BY d.directory)::integer,
  d.directory,d.initial_status,d.status_group,d.fetched_at,
  NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,
  NULL::numeric,NULL::numeric,NULL::numeric,r.is_latest,r.report_month,r.is_month_final,
  NULL::text,NULL::text,d.listing_url
FROM public.looker_reports_monthly r
JOIN public.advice_local_directory_status d ON d.client_id=r.client_id
 AND date_trunc('month',d.fetched_at)::date=r.report_month
UNION ALL
SELECT r.report_id,r.client_id,r.client_name,r.client_url,r.plan,r.partner_group,r.report_date,
  5::integer,'all_ranking'::text,
  row_number() OVER (PARTITION BY r.report_id ORDER BY k.position ASC,k.keyword ASC)::integer,
  k.keyword,NULL::text,'organic_ranking'::text,NULL::timestamptz,
  NULL::numeric,k.volume::numeric,NULL::numeric,k.position::numeric,
  NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,
  r.is_latest,r.report_month,r.is_month_final,
  NULL::text,('#'||k.position::text)::text,NULL::text
FROM public.looker_reports_monthly r
JOIN public.report_snapshots rs ON rs.id=r.report_id
JOIN public.keywords k ON k.audit_id=rs.audit_id
WHERE k.position BETWEEN 1 AND 100 AND k.keyword IS NOT NULL;
REVOKE ALL ON public.looker_report_items_monthly FROM anon,authenticated;
GRANT SELECT ON public.looker_report_items_monthly TO looker_reader;
