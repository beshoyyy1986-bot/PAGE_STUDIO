CREATE TABLE public.protected_admins (
  user_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.protected_admins TO service_role;
ALTER TABLE public.protected_admins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.block_protected_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'protected_admins' THEN
    RAISE EXCEPTION 'Protected admin cannot be removed or changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.protected_admins p WHERE p.user_id = OLD.user_id) THEN
    RAISE EXCEPTION 'Protected admin ownership cannot be removed or changed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protected_admins_no_change
BEFORE UPDATE OR DELETE ON public.protected_admins
FOR EACH ROW EXECUTE FUNCTION public.block_protected_admin_change();

CREATE TRIGGER app_owner_protect_admin
BEFORE UPDATE OR DELETE ON public.app_owner
FOR EACH ROW EXECUTE FUNCTION public.block_protected_admin_change();