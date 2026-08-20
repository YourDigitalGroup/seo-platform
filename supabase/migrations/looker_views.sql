-- Looker Studio integration — flattened, read-only reporting views.
-- Claire connects Looker Studio's PostgreSQL connector to Supabase using a
-- dedicated read-only role that can ONLY see these views (never raw tables,
-- never API keys). See docs/LOOKER_INTEGRATION.md for the connector setup.
-- Idempotent; safe to re-run.

-- One row per audit, per client — scores, grades, and headline metrics.
create or replace view looker_audits as
select
  a.id                as audit_id,
  a.client_id,
  c.name              as client_name,
  c.url               as client_url,
  c.tier              as plan,
  g.name              as partner_group,
  a.run_at,
  a.score,
  a.grade_technical, a.grade_performance, a.grade_onpage, a.grade_schema,
  a.grade_aeo, a.grade_eeat, a.grade_local,
  a.domain_rating, a.org_keywords, a.org_traffic,
  a.org_keywords_top3, a.referring_domains
from audits a
join clients c on c.id = a.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per client — current state for roster-level dashboards.
create or replace view looker_clients as
select
  c.id as client_id, c.name, c.url, c.market, c.tier as plan, c.status,
  g.name as partner_group,
  c.engagement_start_date, c.contract_length_months, c.contract_is_evergreen,
  c.suspended_at, c.suspend_reason,
  (select max(a.run_at) from audits a where a.client_id = c.id)  as last_audit_at,
  (select a.score from audits a where a.client_id = c.id order by a.run_at desc limit 1) as latest_score
from clients c
left join partner_groups g on g.id = c.partner_group_id;

-- One row per content piece — production/approval pipeline reporting.
create or replace view looker_content as
select
  t.id as topic_id, p.client_id, c.name as client_name, g.name as partner_group,
  t.title, t.kind, t.status, t.source, t.location, t.created_at
from content_topics t
join packages p on p.id = t.package_id
join clients c on c.id = p.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- Read-only role for the Looker Studio PostgreSQL connector.
-- After running this, set a password:  alter role looker_reader password '…';
do $$ begin
  if not exists (select from pg_roles where rolname = 'looker_reader') then
    create role looker_reader login password 'CHANGE-ME-IN-DASHBOARD';
  end if;
end $$;
grant usage on schema public to looker_reader;
grant select on looker_audits, looker_clients, looker_content to looker_reader;
