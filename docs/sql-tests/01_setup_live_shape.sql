-- Recreate the relevant tables in their CURRENT live shape (from the CSV dump),
-- i.e. BEFORE reconciliation. Enum columns are modeled as text here (the
-- migration does not touch them, so this does not affect the test).

create table audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid,
  raw jsonb
);

-- fixes: OLD shape — note package_id is NOT NULL (the constraint the migration must relax),
-- and there is no audit_id / status / context / revision / updated_at.
create table fixes (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null,
  kind text not null default 'title_tag',
  target_page text,
  before_text text,
  after_text text,
  schema_jsonld jsonb,
  applied boolean not null default false
);

-- content_topics: OLD shape — no location column.
create table content_topics (
  id uuid primary key default gen_random_uuid(),
  package_id uuid,
  title text,
  target_keyword text,
  kind text,
  model text,
  status text default 'queued',
  source text,
  content_gap_id uuid,
  created_at timestamptz default now()
);

-- packages: OLD shape — no report_html / report_built_at / report_meta.
create table packages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid,
  audit_id uuid,
  cycle_month date default date_trunc('month', now())::date,
  status text default 'ready',
  findings_count int default 0,
  competitors_count int default 0,
  report_url text,
  report_ready boolean default false
);

-- seed one audit + one package so the function-mirroring DML has something to hit.
insert into audits (id) values ('11111111-1111-1111-1111-111111111111');
insert into packages (id, client_id, audit_id)
  values ('22222222-2222-2222-2222-222222222222', gen_random_uuid(), '11111111-1111-1111-1111-111111111111');
