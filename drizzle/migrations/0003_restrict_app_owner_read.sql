DROP POLICY IF EXISTS "owner row readable" ON public.app_owner;
CREATE POLICY "owner reads own row" ON public.app_owner FOR SELECT TO authenticated USING (user_id = auth.uid());