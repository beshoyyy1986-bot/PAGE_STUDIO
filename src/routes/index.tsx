import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "FBBlaster Pro — أداة عملاء صفحات فيسبوك" },
      { name: "description", content: "استخراج المحادثات الفعلية لصفحاتك وإرسال الرد المحفوظ BM AUTO مع دعم الاستكمال." },
      { property: "og:title", content: "FBBlaster Pro — أداة عملاء صفحات فيسبوك" },
      { property: "og:description", content: "استخراج المحادثات الفعلية لصفحاتك وإرسال الرد المحفوظ BM AUTO مع دعم الاستكمال." },
    ],
  }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    throw redirect({ to: data.session ? "/dashboard" : "/auth" });
  },
  component: () => null,
});
