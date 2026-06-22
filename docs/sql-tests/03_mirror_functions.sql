-- Run the EXACT shapes the Edge Functions use. Any missing column errors here
-- because psql runs with ON_ERROR_STOP=1.

\echo '== run-audit: stage a fix (audit_id + status + context, NO package_id) =='
insert into fixes (audit_id, kind, target_page, before_text, status, context)
values (
  '11111111-1111-1111-1111-111111111111',
  'title_tag', '/services/custom-cabinets/', 'Home | Save Our Space', 'suggested',
  jsonb_build_object('business_name','Save Our Space','city','Sioux Falls',
                     'target_keyword','custom cabinets sioux falls')
);

\echo '== generate-fixes: write the artifact + flip to ready + bump revision =='
update fixes
   set after_text = 'Custom Cabinets in Sioux Falls, SD | Save Our Space',
       schema_jsonld = null,
       status = 'ready',
       updated_at = now(),
       revision = revision + 1
 where status = 'suggested';

\echo '== console: mark pushed =='
update fixes set status = 'pushed', updated_at = now() where status = 'ready';

\echo '== generate-report: read pushed fixes by audit_id =='
select count(*) as pushed_fixes
  from fixes
 where audit_id = '11111111-1111-1111-1111-111111111111' and status = 'pushed';

\echo '== run-audit: queue a geo-bound content topic (location) =='
insert into content_topics (package_id, title, target_keyword, kind, model, status, source, location)
values ('22222222-2222-2222-2222-222222222222',
        'Garage Organization in Brandon, SD', 'garage organization brandon',
        'landing', 'sonnet-4-6', 'queued', 'opportunity', 'Brandon');

\echo '== generate-report / console: store + read the report on the package =='
update packages
   set report_html = '<html><body>Progress report</body></html>',
       report_built_at = now(),
       report_meta = jsonb_build_object('keywords_improved', 3)
 where audit_id = '11111111-1111-1111-1111-111111111111';

select (report_html is not null) as report_stored,
       (report_meta->>'keywords_improved') as kw_improved
  from packages
 where audit_id = '11111111-1111-1111-1111-111111111111';

\echo '== final: full fixes row as the console/report would read it =='
select kind, target_page, status, revision, (context->>'city') as city,
       (after_text is not null) as has_artifact
  from fixes;
