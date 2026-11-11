import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { parseCustomerFile } from "@/lib/customer";
import { parseCookies } from "@/lib/cookies";
import { SAVED_REPLY_MARKER } from "@/lib/bot-script";
import { fetchQueue, sessionsQuery, statsQuery, upsertCustomers } from "@/lib/fb-store";
import { closeSession, openSession, reattachSession, sendToCustomer, startRemoteView, syncSessions } from "@/server/fb.functions";
import { Panel, Stat } from "./Panel";
import { ActivityLog } from "./ActivityLog";
import type { LogEntry, Logger } from "./use-log";

type Profile = Tables<"fb_profiles">;
type PageRow = Tables<"fb_pages">;
type Session = Tables<"cloud_sessions">;

const fmt = (n: number) => n.toLocaleString("ar-EG");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const statusLabel: Record<string, { text: string; variant: "success" | "warning" | "danger" | "muted" }> = {
  open: { text: "متصلة", variant: "success" },
  opening: { text: "جاري التجهيز", variant: "warning" },
  lost: { text: "غير متصلة", variant: "warning" },
  close_failed: { text: "فشل الإغلاق", variant: "danger" },
};

export function SendPanel(props: {
  userId: string;
  profile: Profile;
  pages: PageRow[];
  selectedPageId?: string | undefined;
  onSelectPage: (id: string) => void;
  log: Logger;
  entries: LogEntry[];
}) {
  const { profile, pages, selectedPageId: pageId, log } = props;
  const qc = useQueryClient();
  const { data: stats } = useQuery(statsQuery(profile.id, pageId));
  const { data: sessions = [] } = useQuery({ ...sessionsQuery(), refetchInterval: 15000 });

  const openFn = useServerFn(openSession);
  const sendFn = useServerFn(sendToCustomer);
  const closeFn = useServerFn(closeSession);
  const syncFn = useServerFn(syncSessions);
  const reattachFn = useServerFn(reattachSession);
  const viewFn = useServerFn(startRemoteView);

  const [cookies, setCookies] = useState(profile.cookies);
  const [fbUrl, setFbUrl] = useState(profile.fb_url);
  useEffect(() => {
    setCookies(profile.cookies);
    setFbUrl(profile.fb_url);
  }, [profile.id, profile.cookies, profile.fb_url]);

  const [parallel, setParallel] = useState(1);
  const [checkName, setCheckName] = useState(true);
  const [retryFailed, setRetryFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState({ ok: 0, err: 0, done: 0, total: 0 });
  const [current, setCurrent] = useState<Record<string, string>>({});
  const stopRef = useRef(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["stats", profile.id, pageId] });
    qc.invalidateQueries({ queryKey: ["sessions"] });
  };

  // Reconcile recorded sessions with what is really running on the account.
  useEffect(() => {
    syncFn()
      .then((r) => {
        if (r.adopted) log(`🔎 وُجدت ${r.adopted} جلسة مفتوحة على حسابك لم تكن مسجلة — ظاهرة بالأسفل`, "warn");
        qc.invalidateQueries({ queryKey: ["sessions"] });
      })
      .catch((e) => log("⚠️ " + errText(e), "warn"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => void (stopRef.current = true), []);

  async function saveSettings() {
    const { error } = await supabase.from("fb_profiles").update({ cookies, fb_url: fbUrl.trim() || "https://www.facebook.com/messages" }).eq("id", profile.id);
    if (error) throw error;
    qc.invalidateQueries({ queryKey: ["profiles"] });
  }

  async function onFile(file: File) {
    if (!pageId) {
      toast.error("اختر الصفحة أولاً");
      return;
    }
    try {
      const parsed = parseCustomerFile(file.name, await file.text());
      await upsertCustomers(props.userId, profile.id, pageId, parsed.customers);
      log(`📂 تم استيراد ${fmt(parsed.customers.length)} عميل من ${file.name}`, "ok");
      if (parsed.missingConversationId) {
        log(`⚠️ ${fmt(parsed.missingConversationId)} صف بدون معرف محادثة (ملف قديم) — تم تجاهلهم. أعد الاستخراج للحصول عليهم.`, "warn");
      }
      refresh();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  async function sleepInterruptible(ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms && !stopRef.current) await new Promise((r) => setTimeout(r, 400));
  }

  async function start() {
    if (!pageId) {
      toast.error("اختر الصفحة أولاً");
      return;
    }
    try {
      parseCookies(cookies);
    } catch (e) {
      return toast.error(errText(e));
    }
    await saveSettings();
    const queue = await fetchQueue(profile.id, pageId, retryFailed ? ["pending", "failed"] : ["pending"]);
    if (!queue.length) {
      toast.info("لا يوجد عملاء في الانتظار لهذه الصفحة");
      return;
    }

    stopRef.current = false;
    setRunning(true);
    setRun({ ok: 0, err: 0, done: 0, total: queue.length });
    log(`🚀 إرسال لـ ${fmt(queue.length)} عميل عبر ${parallel} جلسة`, "ok");

    // Reuse sessions that are already connected (this is what makes resume after refresh work).
    const usable: Session[] = sessions.filter((s) => s.status === "open" && (s.profile_id === profile.id || !s.profile_id)).slice(0, parallel);
    if (usable.length) log(`♻️ استخدام ${usable.length} جلسة مفتوحة بالفعل`, "info");
    while (usable.length < parallel && !stopRef.current) {
      log(`🖥️ فتح متصفح سحابي جديد...`, "info");
      try {
        const r = await openFn({ data: { profileId: profile.id } });
        if (!r.loggedIn) log("⚠️ الجلسة فتحت لكن فيسبوك طلب تسجيل الدخول — راجع الكوكيز", "warn");
        const { data } = await supabase.from("cloud_sessions").select("*").eq("id", r.id).single();
        if (data) usable.push(data);
        log(`✅ جلسة جاهزة`, "ok");
      } catch (e) {
        log(`❌ ${errText(e)}`, "err");
        break;
      }
      qc.invalidateQueries({ queryKey: ["sessions"] });
    }
    if (!usable.length) {
      setRunning(false);
      return;
    }

    const worker = async (s: Session) => {
      const tag = s.label.slice(-6);
      while (!stopRef.current) {
        const c = queue.shift();
        if (!c) break;
        setCurrent((m) => ({ ...m, [s.id]: c.name }));
        try {
          const r = await sendFn({ data: { sessionId: s.id, customerId: c.id, checkName } });
          if (r.status === "session_lost") {
            queue.unshift(c);
            log(`🔌 [${tag}] الجلسة انقطعت: ${r.reason ?? ""}`, "err");
            break;
          }
          if (r.status === "sent") {
            setRun((x) => ({ ...x, ok: x.ok + 1, done: x.done + 1 }));
            log(`✅ [${tag}] أُرسل لـ ${c.name}`, "ok");
          } else {
            setRun((x) => ({ ...x, err: x.err + 1, done: x.done + 1 }));
            log(`❌ [${tag}] ${c.name}: ${r.reason ?? r.status}`, "err");
          }
        } catch (e) {
          setRun((x) => ({ ...x, err: x.err + 1, done: x.done + 1 }));
          log(`💥 [${tag}] ${c.name}: ${errText(e)}`, "err");
        }
        qc.invalidateQueries({ queryKey: ["stats", profile.id, pageId] });
        if (queue.length && !stopRef.current) await sleepInterruptible(5000 + Math.random() * 7000);
      }
      setCurrent((m) => {
        const { [s.id]: _, ...rest } = m;
        return rest;
      });
    };

    await Promise.all(usable.map(worker));
    setRunning(false);
    refresh();
    log(stopRef.current ? "⏸️ تم الإيقاف — اضغط استكمال للمتابعة من نفس النقطة" : "📊 انتهت قائمة الانتظار", stopRef.current ? "warn" : "ok");
  }

  async function resetUncertain() {
    if (!pageId) return;
    if (!confirm("هذه المحادثات انقطع الإرسال لها في المنتصف وقد تكون الرسالة وصلت. إعادتها للانتظار قد يكرر الرسالة. متابعة؟")) return;
    await supabase.from("customers").update({ send_status: "pending" }).eq("profile_id", profile.id).eq("page_id", pageId).eq("send_status", "in_progress");
    refresh();
  }

  async function close(s: Session) {
    if (!confirm("إغلاق هذا المتصفح السحابي نهائياً؟")) return;
    const r = await closeFn({ data: { sessionId: s.id } }).catch((e) => ({ closed: false, detail: errText(e) }));
    if (r.closed) log("🗑 تم إغلاق الجلسة والتأكد من إغلاقها", "ok");
    else log("❌ لم يتم التأكد من الإغلاق: " + r.detail, "err");
    refresh();
  }

  async function closeAll() {
    if (!confirm("إيقاف الإرسال وإغلاق كل المتصفحات السحابية؟")) return;
    stopRef.current = true;
    for (const s of sessions) {
      const r = await closeFn({ data: { sessionId: s.id } }).catch((e) => ({ closed: false, detail: errText(e) }));
      log(r.closed ? `🗑 أُغلقت ${s.label}` : `❌ ${s.label}: ${r.detail}`, r.closed ? "ok" : "err");
    }
    refresh();
  }

  async function reattach(s: Session) {
    try {
      await reattachFn({ data: { sessionId: s.id, profileId: profile.id } });
      log("🔗 تم إعادة الاتصال بالجلسة", "ok");
    } catch (e) {
      log("❌ " + errText(e), "err");
    }
    refresh();
  }

  async function view(s: Session) {
    const w = window.open("about:blank", "_blank");
    try {
      const { url } = await viewFn({ data: { sessionId: s.id } });
      if (w) w.location.href = url;
    } catch (e) {
      w?.close();
      toast.error(errText(e));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-80">
        <Panel title="الصفحة">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={pageId ?? ""}
            onChange={(e) => props.onSelectPage(e.target.value)}
          >
            <option value="" disabled>اختر صفحة</option>
            {pages.map((p) => (
              <option key={p.page_id} value={p.page_id}>{p.name}</option>
            ))}
          </select>
          <label className="mt-3 flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed border-border p-3 text-center text-xs text-muted-foreground hover:border-primary hover:text-primary">
            <input type="file" accept=".json,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            استيراد ملف عملاء (JSON/CSV) لهذه الصفحة
            <span className="opacity-70">العملاء المستخرجين محفوظين تلقائياً — الملف اختياري</span>
          </label>
        </Panel>

        <Panel title="حساب فيسبوك (للإرسال)">
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">الكوكيز (JSON أو c_user=..; xs=..)</Label>
              <Textarea dir="ltr" rows={3} className="font-mono text-[11px]" value={cookies} onChange={(e) => setCookies(e.target.value)} onBlur={() => saveSettings().catch(() => {})} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">رابط صندوق الرسائل</Label>
              <Input dir="ltr" value={fbUrl} onChange={(e) => setFbUrl(e.target.value)} onBlur={() => saveSettings().catch(() => {})} />
            </div>
          </div>
        </Panel>

        <Panel title="الإعدادات">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">الجلسات المتوازية: <b>{parallel}</b></Label>
              <Slider min={1} max={5} step={1} value={[parallel]} onValueChange={(v) => setParallel(v[0] ?? 1)} disabled={running} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">التحقق من اسم العميل قبل الإرسال</Label>
              <Switch checked={checkName} onCheckedChange={setCheckName} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">إعادة المحاولة للي فشلوا</Label>
              <Switch checked={retryFailed} onCheckedChange={setRetryFailed} />
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              يتم إرسال الرد المحفوظ المسمى <b className="text-foreground">{SAVED_REPLY_MARKER}</b> فقط. لو مش موجود، المحادثة تتسجل فشل ومفيش حاجة تتبعت.
            </p>
          </div>
        </Panel>

        {running ? (
          <Button variant="soft-destructive" onClick={() => (stopRef.current = true)}>⏸️ إيقاف الإرسال</Button>
        ) : (
          <Button onClick={() => start().catch((e) => { setRunning(false); toast.error(errText(e)); })} disabled={!pageId}>
            🚀 {stats && stats.sent + stats.failed > 0 ? "استكمال الإرسال" : "بدء الإرسال"}
          </Button>
        )}
        <Button variant="soft-destructive" onClick={closeAll} disabled={!sessions.length}>⏹ إيقاف الكل وإغلاق الجلسات</Button>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Stat label="في الانتظار" value={stats?.pending ?? 0} />
          <Stat label="تم الإرسال" value={stats?.sent ?? 0} tone="success" />
          <Stat label="فشل" value={stats?.failed ?? 0} tone="danger" />
          <Stat label="غير مؤكد" value={stats?.in_progress ?? 0} tone="warning" />
          <Stat label="الإجمالي" value={stats?.total ?? 0} tone="info" />
          {running && (
            <span className="text-xs text-muted-foreground ms-auto">
              هذه الدورة: {fmt(run.done)}/{fmt(run.total)} — ✅ {fmt(run.ok)} ❌ {fmt(run.err)}
            </span>
          )}
          {!running && (stats?.in_progress ?? 0) > 0 && (
            <Button size="sm" variant="soft" className="ms-auto" onClick={resetUncertain}>إعادة غير المؤكد للانتظار</Button>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">المتصفحات السحابية ({sessions.length})</span>
          <Button size="sm" variant="ghost" onClick={() => syncFn().then(refresh).catch((e) => toast.error(errText(e)))}>🔄 مزامنة مع حسابي</Button>
        </div>
        <div className="grid min-h-[120px] flex-1 auto-rows-min gap-3 overflow-y-auto p-3 md:grid-cols-2">
          {sessions.length === 0 && (
            <div className="col-span-full flex h-24 items-center justify-center text-sm text-muted-foreground">لا توجد متصفحات مفتوحة</div>
          )}
          {sessions.map((s) => {
            const st = statusLabel[s.status] ?? { text: s.status, variant: "muted" as const };
            return (
              <div key={s.id} className="rounded-lg border border-border bg-secondary/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" dir="ltr">{s.label}</div>
                    <div className="text-[11px] text-muted-foreground">{new Date(s.created_at).toLocaleString("ar-EG")}</div>
                  </div>
                  <Badge variant={st.variant}>{st.text}</Badge>
                </div>
                {current[s.id] && <div className="mt-2 truncate text-xs text-primary">▶ {current[s.id]}</div>}
                {s.last_error && <div className="mt-2 text-[11px] text-warning">{s.last_error}</div>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="soft" onClick={() => view(s)}>🖥️ عرض</Button>
                  {s.status !== "open" && s.status !== "close_failed" && (
                    <Button size="sm" variant="soft" onClick={() => reattach(s)}>🔗 اتصال</Button>
                  )}
                  <Button size="sm" variant="soft-destructive" onClick={() => close(s)}>إغلاق</Button>
                </div>
              </div>
            );
          })}
        </div>
        <ActivityLog entries={props.entries} className="h-44 shrink-0 border-t border-border" />
      </div>
    </div>
  );
}
