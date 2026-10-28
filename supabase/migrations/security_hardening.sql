-- Security hardening (QA pass, 2026-10-28). Idempotent; safe to re-run.
--
-- Findings this closes, all reachable with only the public (anon) key that
-- ships inside index.html:
--   1. client_health, group_rollup and seop_scheduler_health ran with their
--      owner's rights (bypassing RLS) and kept Supabase's default grants, so
--      anyone could read every client — and client_health is an updatable
--      view, so anyone could UPDATE clients.tier/status/partner_group_id/
--      assigned_to through it.
--   2. seop_invoke_scheduler() was executable by anon: anyone could trigger
--      audits/reports for every client (paid API usage).
--   3. profiles: the "update own profile" policy has no column limit, so any
--      signed-in staff member could set their own role to super_admin.
--   4. Several policies allowed ANY signed-in user (not just staff). Email
--      sign-up is open on the project, so a stranger who confirms an email
--      would get read/write on settings, deliverables, catalog and checks.
--   5. SECURITY DEFINER helpers had a mutable search_path.

-- 1 ── views run as the caller, read-only, staff only
alter view public.client_health set (security_invoker = true);
alter view public.group_rollup  set (security_invoker = true);
revoke all on public.client_health, public.group_rollup, public.seop_scheduler_health from anon, authenticated;
grant select on public.client_health, public.group_rollup to authenticated;
-- seop_scheduler_health stays SQL-Editor-only (it reads vault + cron state).

-- 2 ── the scheduler trigger is for pg_cron and the SQL Editor only
revoke execute on function public.seop_invoke_scheduler(text) from public, anon, authenticated;

-- 3 ── profiles are written only by the manage-users function (service role,
--      admin-checked). No direct UPDATE: a self-set name renders across the console.
revoke update on public.profiles from anon, authenticated;
-- (no column grants)

-- 4 ── "any signed-in user" → staff (a row in profiles)
do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='app_settings' and policyname='app_settings_rw') then
    alter policy app_settings_rw on public.app_settings using (public.is_staff()) with check (public.is_staff());
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='audit_checks' and policyname='audit_checks_staff_all') then
    alter policy audit_checks_staff_all on public.audit_checks using (public.is_staff()) with check (public.is_staff());
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='audit_jobs' and policyname='audit_jobs_read') then
    alter policy audit_jobs_read on public.audit_jobs using (public.is_staff());
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='service_templates' and policyname='service_templates_staff_all') then
    alter policy service_templates_staff_all on public.service_templates using (public.is_staff()) with check (public.is_staff());
  end if;
  -- duplicate of "staff rw deliv" that let any signed-in user in
  if exists (select 1 from pg_policies where schemaname='public' and tablename='deliverables' and policyname='deliverables_staff_all') then
    drop policy deliverables_staff_all on public.deliverables;
  end if;
end $$;

-- 5 ── pin search_path on the SECURITY DEFINER helpers
alter function public.is_admin()      set search_path = public;
alter function public.is_am()         set search_path = public;
alter function public.is_staff()      set search_path = public;
alter function public.is_strategist() set search_path = public;
alter function public.bump_last_audit() set search_path = public;
alter function public.seop_invoke_scheduler(text) set search_path = public;
