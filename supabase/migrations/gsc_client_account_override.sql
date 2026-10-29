-- Per-client GSC credential selector. NULL keeps the existing partner-group setting.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS gsc_account_override text;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_gsc_account_override_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_gsc_account_override_check
  CHECK (gsc_account_override IS NULL OR gsc_account_override IN ('default','44i'));

-- All staff may edit other client fields. Protect only this sensitive column
-- at the database boundary, including direct PostgREST updates.
CREATE OR REPLACE FUNCTION public.protect_gsc_account_override()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.gsc_account_override IS DISTINCT FROM OLD.gsc_account_override THEN
    IF current_user NOT IN ('postgres','service_role')
       AND NOT EXISTS (
         SELECT 1 FROM public.profiles
         WHERE id=auth.uid() AND role='super_admin'
       )
    THEN
      RAISE EXCEPTION 'Only super admins may change the Search Console account';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS protect_gsc_account_override ON public.clients;
CREATE TRIGGER protect_gsc_account_override
  BEFORE UPDATE OF gsc_account_override ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.protect_gsc_account_override();
