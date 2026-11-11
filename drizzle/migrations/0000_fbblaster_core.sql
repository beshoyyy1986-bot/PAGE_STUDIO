
CREATE TABLE public.app_owner (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.app_owner TO authenticated;
GRANT ALL ON public.app_owner TO service_role;
ALTER TABLE public.app_owner ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner row readable" ON public.app_owner FOR SELECT TO authenticated USING (true);
CREATE POLICY "first user claims ownership" ON public.app_owner FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE TABLE public.fb_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  access_token text NOT NULL DEFAULT '',
  cookies text NOT NULL DEFAULT '',
  fb_url text NOT NULL DEFAULT 'https://www.facebook.com/messages',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fb_profiles TO authenticated;
GRANT ALL ON public.fb_profiles TO service_role;
ALTER TABLE public.fb_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profiles" ON public.fb_profiles FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.fb_pages (
  profile_id uuid NOT NULL REFERENCES public.fb_profiles(id) ON DELETE CASCADE,
  page_id text NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  fan_count integer NOT NULL DEFAULT 0,
  conversation_count integer,
  count_complete boolean NOT NULL DEFAULT false,
  counted_at timestamptz,
  oldest_post_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, page_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fb_pages TO authenticated;
GRANT ALL ON public.fb_pages TO service_role;
ALTER TABLE public.fb_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pages" ON public.fb_pages FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid NOT NULL REFERENCES public.fb_profiles(id) ON DELETE CASCADE,
  page_id text NOT NULL,
  conversation_id text NOT NULL,
  participant_id text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  send_status text NOT NULL DEFAULT 'pending',
  send_reason text,
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, page_id, conversation_id)
);
CREATE INDEX customers_queue_idx ON public.customers (profile_id, page_id, send_status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own customers" ON public.customers FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.cloud_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid REFERENCES public.fb_profiles(id) ON DELETE SET NULL,
  address text NOT NULL,
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX cloud_sessions_status_idx ON public.cloud_sessions (user_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cloud_sessions TO authenticated;
GRANT ALL ON public.cloud_sessions TO service_role;
ALTER TABLE public.cloud_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sessions" ON public.cloud_sessions FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
