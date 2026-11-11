import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getOldestPostDate, getPages, type FbPage } from "@/lib/facebook";
import { pagesQuery, profilesQuery } from "@/lib/fb-store";
import { whoOwns } from "@/server/fb.functions";
import { PagesPanel } from "@/components/fb/PagesPanel";
import { SendPanel } from "@/components/fb/SendPanel";
import { ActivityLog } from "@/components/fb/ActivityLog";
import { useLog } from "@/components/fb/use-log";

type Search = { tab?: "pages" | "send"; p?: string; pg?: string };

export const Route = createFileRoute("/_authenticated/dashboard")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: s.tab === "send" ? "send" : s.tab === "pages" ? "pages" : undefined,
    p: typeof s.p === "string" ? s.p : undefined,
    pg: typeof s.pg === "string" ? s.pg : undefined,
  }),
  head: () => ({
    meta: [
      { title: "لوحة التحكم — FBBlaster Pro" },
      { name: "description", content: "صفحاتك، عدد المحادثات الفعلية، استخراج العملاء والإرسال مع الاستكمال." },
      { property: "og:title", content: "لوحة التحكم — FBBlaster Pro" },
      { property: "og:description", content: "صفحاتك، عدد المحادثات الفعلية، استخراج العملاء والإرسال مع الاستكمال." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/dashboard" });
  const qc = useQueryClient();
  const { entries, log } = useLog();
  const ownerFn = useServerFn(whoOwns);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    ownerFn().then((r) => setAllowed(r.allowed)).catch(() => setAllowed(false));
  }, [ownerFn]);

  const { data: profiles } = useQuery(profilesQuery());
  const creating = useRef(false);
  useEffect(() => {
    if (profiles && profiles.length === 0 && !creating.current) {
      creating.current = true;
      supabase.from("fb_profiles").insert({ user_id: user.id, name: "الرئيسي" }).then(() => qc.invalidateQueries({ queryKey: ["profiles"] }));
    }
  }, [profiles, user.id, qc]);

  const profile = profiles?.find((p) => p.id === search.p) ?? profiles?.[0];
  const tab = search.tab ?? "pages";
  const { data: pages = [] } = useQuery(pagesQuery(profile?.id));

  const setSearch = (patch: Partial<Search>) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  // Page access tokens come from the saved user token and are only kept in memory.
  const [tokens, setTokens] = useState<Map<string, FbPage>>(new Map());
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);

  const loadPages = useCallback(
    async (token: string, profileId: string) => {
      setTokensLoading(true);
      setTokensError(null);
      try {
        const list = await getPages(token);
        setTokens(new Map(list.map((p) => [p.id, p])));
        if (list.length) {
          const { error } = await supabase.from("fb_pages").upsert(
            list.map((p) => ({ profile_id: profileId, page_id: p.id, user_id: user.id, name: p.name, fan_count: p.fan_count ?? 0, updated_at: new Date().toISOString() })),
            { onConflict: "profile_id,page_id" },
          );
          if (error) throw error;
        }
        qc.invalidateQueries({ queryKey: ["pages", profileId] });
        log(`✅ تم جلب ${list.length} صفحة`, "ok");
        // oldest-post estimate, filled once per page
        const { data: rows } = await supabase.from("fb_pages").select("page_id,oldest_post_at").eq("profile_id", profileId);
        for (const p of list) {
          if (rows?.find((r) => r.page_id === p.id)?.oldest_post_at) continue;
          getOldestPostDate(p)
            .then((r) => r.date && supabase.from("fb_pages").update({ oldest_post_at: r.date }).eq("profile_id", profileId).eq("page_id", p.id))
            .then(() => qc.invalidateQueries({ queryKey: ["pages", profileId] }))
            .catch(() => {});
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setTokensError(msg);
        log("❌ " + msg, "err");
      } finally {
        setTokensLoading(false);
      }
    },
    [qc, user.id, log],
  );

  // After a refresh, reload page access automatically from the saved token.
  useEffect(() => {
    setTokens(new Map());
    if (profile?.access_token) loadPages(profile.access_token, profile.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  async function saveToken(token: string) {
    if (!profile) return;
    await supabase.from("fb_profiles").update({ access_token: token }).eq("id", profile.id);
    qc.invalidateQueries({ queryKey: ["profiles"] });
    await loadPages(token, profile.id);
  }

  async function addProfile() {
    const name = prompt("اسم البروفايل الجديد");
    if (!name?.trim()) return;
    const { data } = await supabase.from("fb_profiles").insert({ user_id: user.id, name: name.trim() }).select().single();
    await qc.invalidateQueries({ queryKey: ["profiles"] });
    if (data) setSearch({ p: data.id, pg: undefined });
  }

  async function deleteProfile() {
    if (!profile || (profiles?.length ?? 0) <= 1) return toast.error("لا يمكن حذف آخر بروفايل");
    if (!confirm(`حذف "${profile.name}" وكل بياناته (الصفحات والعملاء المستخرجين)؟`)) return;
    await supabase.from("fb_profiles").delete().eq("id", profile.id);
    await qc.invalidateQueries({ queryKey: ["profiles"] });
    setSearch({ p: undefined, pg: undefined });
  }

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  if (allowed === false) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-muted-foreground">هذا الحساب غير مصرح له باستخدام الأداة. الأداة مخصصة لحساب المالك فقط.</p>
        <Button variant="soft" onClick={signOut}>تسجيل الخروج</Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar px-5 py-2.5">
        <div className="text-lg font-bold tracking-tight">
          <span className="text-brand">FB</span>Blaster <span className="text-xs text-muted-foreground">Pro</span>
        </div>
        <nav className="flex gap-1 rounded-lg bg-secondary p-1">
          {(["pages", "send"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setSearch({ tab: t })}
              className={cn("rounded-md px-4 py-1.5 text-sm transition", tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {t === "pages" ? "📊 الصفحات والعملاء" : "🚀 الإرسال"}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={profile?.id ?? ""}
            onChange={(e) => setSearch({ p: e.target.value, pg: undefined })}
          >
            {profiles?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <Button size="sm" variant="soft" onClick={addProfile}>+ بروفايل</Button>
          <Button size="sm" variant="soft-destructive" onClick={deleteProfile} aria-label="حذف البروفايل">✕</Button>
          <Button size="sm" variant="ghost" onClick={signOut}>خروج</Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-4">
        {!profile ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">جاري التحميل...</div>
        ) : tab === "pages" ? (
          <div className="flex h-full flex-col gap-3">
            <div className="min-h-0 flex-1">
              <PagesPanel
                userId={user.id}
                profile={profile}
                pages={pages}
                tokens={tokens}
                tokensLoading={tokensLoading}
                tokensError={tokensError}
                onSaveToken={saveToken}
                selectedPageId={search.pg}
                onSelectPage={(id) => setSearch({ pg: id })}
                log={log}
              />
            </div>
            <ActivityLog entries={entries} className="h-28 shrink-0 rounded-xl border border-border" />
          </div>
        ) : (
          <SendPanel
            userId={user.id}
            profile={profile}
            pages={pages}
            selectedPageId={search.pg}
            onSelectPage={(id) => setSearch({ pg: id })}
            log={log}
            entries={entries}
          />
        )}
      </main>
    </div>
  );
}
