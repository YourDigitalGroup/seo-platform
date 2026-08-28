-- ════════════════════════════════════════════════════════════════════════════
--  service_catalog.sql
--  The service/cadence data model. Moves the plan catalog out of front-end JS
--  (the old hardcoded DELIVS object in index.html) into a real table with an
--  explicit cadence type, and makes contract length a per-client fact instead
--  of a hardcoded 6 months.
--
--  Ground truth: the "New SEO Package Offerings" pricing sheet.
--  Plans (clients.tier keeps its existing keys — no data rewrite):
--    starter → SEO Starter ($199)   builder → SEO Pro ($599)   pro → AEO Pro ($799)
--
--  Cadence types:
--    recurring       happens every recurrence_interval months,
--                    quantity_per_interval each time
--                    (GBP posts 1–3×/mo, Monthly Reporting, AEO Pillar Pages 1×/mo)
--    fixed_quantity  quantity_total across the WHOLE contract, not per month
--                    (Branded Blog Writing 1/2/3 total — per-contract total
--                     confirmed with the business owner 2026-07-02;
--                     Radio to Video Ad 1/2 total; Targeted Landing Pages ≤5 total)
--    one_time        a single setup / as-needed task
--                    (Schema Implementation,
--                     Domain Optimization 404s/301s)
--    continuous      always-on monitoring — not a discrete scheduled task, so it
--                    never generates deliverables rows
--                    (Local Listing Optimization, Reputation Monitoring, Core SEO
--                     Monitoring, Internal Link Strategy, Sitemap Refresh, Keyword
--                     Research & Strategy, Site Health Scan, High-Intent Keyword
--                     Targeting, Content Recommendations)
--
--  Note: on the pricing sheet the "Monthly Reporting" label is visually stranded
--  under the AEO Pro column (source-doc formatting artifact); it is seeded for
--  all three plans, matching the business reality that every retainer reports.
--
--  Additive + idempotent, in the house style: text + CHECK instead of a pg enum
--  (same reasoning as campaign_engine.sql — nothing to guess, easy to evolve).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) The plan/service catalog. One row per (plan tier, service).
create table if not exists service_templates (
  id                    uuid primary key default gen_random_uuid(),
  tier                  text not null check (tier in ('starter','builder','pro')),
  name                  text not null,
  engine                text not null default 'audit'
                        check (engine in ('content','fix','audit','reporting')),
  content_kind          text,   -- content engine only: gbp_post | blog | pillar | landing
  cadence_type          text not null
                        check (cadence_type in ('one_time','fixed_quantity','recurring','continuous')),
  recurrence_interval   integer not null default 1,  -- recurring: months between occurrences
  quantity_per_interval integer,                     -- recurring: how many per occurrence
  quantity_total        integer,                     -- fixed_quantity: total across the contract
  auto                  boolean not null default true,
  sort_order            integer not null default 100,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (tier, name)
);

alter table service_templates enable row level security;
drop policy if exists service_templates_staff_all on service_templates;
create policy service_templates_staff_all on service_templates
  for all to authenticated using (true) with check (true);

-- 2) Contract shape on clients. A contract can be 3, 6, 12 months, or evergreen
--    without a code change. engagement_start_date is ensured here so this
--    migration stands alone even though the live DB already has it.
alter table clients add column if not exists engagement_start_date date;
alter table clients add column if not exists contract_length_months integer not null default 6;
alter table clients add column if not exists contract_is_evergreen boolean not null default false;
alter table clients add column if not exists contract_end_date date generated always as (
  case when contract_is_evergreen or engagement_start_date is null then null
       else (engagement_start_date + make_interval(months => contract_length_months))::date
  end
) stored;

-- 3) Deliverables carry their cadence so the roadmap can render one-time,
--    fixed-quantity, recurring, and continuous items differently.
alter table deliverables add column if not exists service_template_id uuid references service_templates(id) on delete set null;
alter table deliverables add column if not exists cadence_type text
  check (cadence_type is null or cadence_type in ('one_time','fixed_quantity','recurring','continuous'));

-- 4) Seed the catalog from the pricing sheet. Idempotent: re-running syncs the
--    row values (quantities, cadence, ordering) without duplicating.
insert into service_templates
  (tier, name, engine, content_kind, cadence_type, recurrence_interval, quantity_per_interval, quantity_total, auto, sort_order)
values
  -- ── all plans ─────────────────────────────────────────────────────────────
  ('starter','GBP Management & Posting',              'content','gbp_post','recurring',      1, 1, null, true,  10),
  ('builder','GBP Management & Posting',              'content','gbp_post','recurring',      1, 2, null, true,  10),
  ('pro',    'GBP Management & Posting',              'content','gbp_post','recurring',      1, 3, null, true,  10),
  ('starter','Branded Blog Writing',                  'content','blog',    'fixed_quantity', 1, null, 1, true,  20),
  ('builder','Branded Blog Writing',                  'content','blog',    'fixed_quantity', 1, null, 2, true,  20),
  ('pro',    'Branded Blog Writing',                  'content','blog',    'fixed_quantity', 1, null, 3, true,  20),
  ('starter','Local Listing Optimization',            'fix',    null,      'continuous',     1, null, null, true, 40),
  ('builder','Local Listing Optimization',            'fix',    null,      'continuous',     1, null, null, true, 40),
  ('pro',    'Local Listing Optimization',            'fix',    null,      'continuous',     1, null, null, true, 40),
  ('starter','Reputation Monitoring',                 'reporting',null,    'continuous',     1, null, null, true, 50),
  ('builder','Reputation Monitoring',                 'reporting',null,    'continuous',     1, null, null, true, 50),
  ('pro',    'Reputation Monitoring',                 'reporting',null,    'continuous',     1, null, null, true, 50),
  ('starter','Monthly Reporting',                     'reporting',null,    'recurring',      1, 1, null, true, 140),
  ('builder','Monthly Reporting',                     'reporting',null,    'recurring',      1, 1, null, true, 140),
  ('pro',    'Monthly Reporting',                     'reporting',null,    'recurring',      1, 1, null, true, 140),
  -- ── SEO Pro + AEO Pro ─────────────────────────────────────────────────────
  ('builder','Radio to Video Ad',                     'content',null,      'fixed_quantity', 1, null, 1, false, 30),
  ('pro',    'Radio to Video Ad',                     'content',null,      'fixed_quantity', 1, null, 2, false, 30),
  ('builder','Keyword Research & Strategy',           'audit',  null,      'continuous',     1, null, null, true, 60),
  ('pro',    'Keyword Research & Strategy',           'audit',  null,      'continuous',     1, null, null, true, 60),
  ('builder','Site Health Scan',                      'audit',  null,      'continuous',     1, null, null, false, 70),
  ('pro',    'Site Health Scan',                      'audit',  null,      'continuous',     1, null, null, false, 70),
  ('builder','High-Intent Keyword Targeting',         'audit',  null,      'continuous',     1, null, null, true, 80),
  ('pro',    'High-Intent Keyword Targeting',         'audit',  null,      'continuous',     1, null, null, true, 80),
  ('builder','Content Recommendations',               'audit',  null,      'continuous',     1, null, null, true, 90),
  ('pro',    'Content Recommendations',               'audit',  null,      'continuous',     1, null, null, true, 90),
  ('builder','Core SEO Monitoring',                   'audit',  null,      'continuous',     1, null, null, true, 100),
  ('pro',    'Core SEO Monitoring',                   'audit',  null,      'continuous',     1, null, null, true, 100),
  ('builder','Domain Optimization (404 fixes, 301 redirects)','fix',null,  'one_time',       1, null, null, true, 110),
  ('pro',    'Domain Optimization (404 fixes, 301 redirects)','fix',null,  'one_time',       1, null, null, true, 110),
  ('builder','Internal Link Strategy',                'fix',    null,      'continuous',     1, null, null, true, 120),
  ('pro',    'Internal Link Strategy',                'fix',    null,      'continuous',     1, null, null, true, 120),
  ('builder','Sitemap Refresh',                       'fix',    null,      'continuous',     1, null, null, true, 130),
  ('pro',    'Sitemap Refresh',                       'fix',    null,      'continuous',     1, null, null, true, 130),
  -- ── AEO Pro only ──────────────────────────────────────────────────────────
  ('pro',    'AEO Research & Optimization',           'audit',  null,      'recurring',      1, 1,    null, false, 150),
  ('pro',    'AEO Pillar Pages',                      'content','pillar',  'recurring',      1, 1, null, true, 160),
  ('pro',    'Targeted Landing Pages (up to 5)',      'content','landing', 'fixed_quantity', 1, null, 5, true, 170),
  ('pro',    'Schema Implementation',                 'fix',    null,      'one_time',       1, null, null, true, 180)
on conflict (tier, name) do update set
  engine                = excluded.engine,
  content_kind          = excluded.content_kind,
  cadence_type          = excluded.cadence_type,
  recurrence_interval   = excluded.recurrence_interval,
  quantity_per_interval = excluded.quantity_per_interval,
  quantity_total        = excluded.quantity_total,
  auto                  = excluded.auto,
  sort_order            = excluded.sort_order,
  active                = true;
