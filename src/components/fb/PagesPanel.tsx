import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { countConversations, getConversationBatch, type FbPage } from "@/lib/facebook";
import { extractCustomer, toCsv, uniqueByConversation, type Customer } from "@/lib/customer";
import { countCustomers, fetchCustomersForExport, statsQuery, upsertCustomers } from "@/lib/fb-store";
import { Panel, Stat } from "./Panel";
import type { Logger } from "./use-log";

type PageRow = Tables<"fb_pages">;
type Profile = Tables<"fb_profiles">;

const fmt = (n: number) => n.toLocaleString("en-US");

export function PagesPanel(props: {
  userId: string;
  profile: Profile;
  pages: PageRow[];
  tokens: Map<string, FbPage>;
  tokensLoading: boolean;
  tokensError: string | null;
  onSaveToken: (token: string) => Promise<void>;
  selectedPageId?: string | undefined;
  onSelectPage: (id: string) => void;
  log: Logger;
}) {
  const { profile, pages, tokens, selectedPageId, log } = props;
  const qc = useQueryClient();
  const [token, setToken] = useState(profile.access_token);
  useEffect(() => setToken(profile.access_token), [profile.id, profile.access_token]);

  // live counting progress per page
  const [counting, setCounting] = useState<Record<string, number>>({});
  const countStop = useRef(false);
  const countingBusy = useRef(false);

  const [extract, setExtract] = useState<{ pageId: string; n: number } | null>(null);
  const extractStop = useRef(false);

  const refreshPages = () => qc.invalidateQueries({ queryKey: ["pages", profile.id] });

  async function runCount(row: PageRow) {
    const page = tokens.get(row.page_id);
    if (!page) return;
    setCounting((c) => ({ ...c, [row.page_id]: 0 }));
    try {
      const r = await countConversations(page, (n) => setCounting((c) => ({ ...c, [row.page_id]: n })), () => countStop.current);
      await supabase
        .from("fb_pages")
        .update({ conversation_count: r.count, count_complete: r.complete, counted_at: new Date().toISOString() })
        .eq("profile_id", profile.id)
        .eq("page_id", row.page_id);
      log(`💬 "${row.name}": ${fmt(r.count)} محادثة${r.complete ? "" : " (العد توقف قبل النهاية)"}`, r.complete ? "ok" : "warn");
    } catch (e) {
      log(`⚠️ "${row.name}": تعذر عدّ المحادثات — ${e instanceof Error ? e.message : e}`, "warn");
    } finally {
      setCounting((c) => {
        const { [row.page_id]: _, ...rest } = c;
        return rest;
      });
      refreshPages();
    }
  }

  // Count pages that were never counted, one at a time to stay within Facebook's limits.
  useEffect(() => {
    if (!tokens.size || countingBusy.current) return;
    const todo = pages.filter((p) => p.conversation_count == null && tokens.has(p.page_id));
    if (!todo.length) return;
    countingBusy.current = true;
    countStop.current = false;
    (async () => {
      for (const p of todo) {
        if (countStop.current) break;
        await runCount(p);
      }
      countingBusy.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, pages.length]);

  useEffect(() => () => {
    countStop.current = true;
    extractStop.current = true;
  }, []);

  async function runExtraction(row: PageRow, fresh: boolean) {
    const page = tokens.get(row.page_id);
    if (!page) {
      toast.error("بيانات الصفحة لم تُحمّل بعد — تأكد من التوكن");
      return;
    }
    if (extract) {
      toast.error("في استخراج شغال بالفعل");
      return;
    }
    extractStop.current = false;
    let after = fresh ? null : row.extract_after;
    const seen = new Set<string>();
    let extracted = fresh ? 0 : row.extracted_count;
    setExtract({ pageId: row.page_id, n: extracted });
    log(`${fresh || !after ? "▶️ بدء" : "⏩ استكمال"} استخراج "${row.name}"`, "info");
    await supabase.from("fb_pages").update({ extract_done: false }).eq("profile_id", profile.id).eq("page_id", row.page_id);
    try {
      for (;;) {
        if (extractStop.current) {
          log(`⏸️ تم إيقاف الاستخراج — يمكنك الاستكمال لاحقاً من نفس النقطة`, "warn");
          break;
        }
        const batch = await getConversationBatch(page, after);
        batch.data.forEach((c: { id?: string }) => c.id && seen.add(c.id));
        const customers = uniqueByConversation(
          batch.data.map((c) => extractCustomer(c, row.page_id)).filter((c): c is Customer => c !== null),
        );
        await upsertCustomers(props.userId, profile.id, row.page_id, customers);
        extracted = await countCustomers(profile.id, row.page_id);
        after = batch.done ? null : batch.after;
        const patch: Partial<PageRow> = { extract_after: after, extracted_count: extracted, extract_done: batch.done };
        if (batch.done && fresh) {
          Object.assign(patch, { conversation_count: seen.size, count_complete: true, counted_at: new Date().toISOString() });
        }
        await supabase.from("fb_pages").update(patch).eq("profile_id", profile.id).eq("page_id", row.page_id);
        setExtract({ pageId: row.page_id, n: extracted });
        if (batch.done) {
          log(`✅ اكتمل استخراج "${row.name}": ${fmt(extracted)} عميل (محادثة فعلية)`, "ok");
          break;
        }
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 150));
      }
    } catch (e) {
      log(`❌ الاستخراج توقف: ${e instanceof Error ? e.message : e} — اضغط "استكمال" للمتابعة`, "err");
    } finally {
      setExtract(null);
      refreshPages();
      qc.invalidateQueries({ queryKey: ["stats", profile.id, row.page_id] });
    }
  }

  async function exportData(row: PageRow, fmtType: "json" | "csv") {
    const rows = await fetchCustomersForExport(profile.id, row.page_id);
    if (!rows.length) {
      toast.error("لا يوجد عملاء مستخرجين لهذه الصفحة");
      return;
    }
    const list = rows.map((r) => ({ conversationId: r.conversation_id, participantId: r.participant_id, name: r.name }));
    const content = fmtType === "json" ? JSON.stringify(list, null, 2) : "\uFEFF" + toCsv(list);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: fmtType === "json" ? "application/json" : "text/csv" }));
    a.download = `customers_${row.name}_${Date.now()}.${fmtType}`;
    a.click();
    log(`📥 تم تصدير ${fmt(list.length)} عميل (${fmtType.toUpperCase()})`, "ok");
  }

  const selected = pages.find((p) => p.page_id === selectedPageId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
        <Panel title="توكن فيسبوك">
          <div className="space-y-2">
            <Input type="password" dir="ltr" placeholder="EAAxxxxxxxx..." value={token} onChange={(e) => setToken(e.target.value)} />
            <Button className="w-full" disabled={props.tokensLoading || !token.trim()} onClick={() => props.onSaveToken(token.trim())}>
              {props.tokensLoading ? "جاري جلب الصفحات..." : "حفظ وجلب الصفحات"}
            </Button>
            {props.tokensError && <p className="text-xs text-destructive">{props.tokensError}</p>}
          </div>
        </Panel>
        {selected && (
          <SelectedPage
            row={selected}
            profileId={profile.id}
            hasToken={tokens.has(selected.page_id)}
            counting={counting[selected.page_id]}
            extracting={extract?.pageId === selected.page_id ? extract.n : undefined}
            anyExtract={!!extract}
            onCount={() => runCount(selected)}
            onExtract={(fresh) => runExtraction(selected, fresh)}
            onStop={() => (extractStop.current = true)}
            onExport={(t) => exportData(selected, t)}
          />
        )}
        <p className="rounded-lg border border-info/25 bg-info/5 p-3 text-xs leading-6 text-info">
          الهدف هو عدد المحادثات الفعلية للصفحة: كل عميل = محادثة واحدة (معرف المحادثة + معرف الشخص + الاسم). لا يتم الاعتماد على عدد الرسائل أو مين بدأ المحادثة.
        </p>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pages.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span className="text-3xl">🔑</span>أدخل التوكن واضغط "حفظ وجلب الصفحات"
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pages.map((p) => (
              <button
                key={p.page_id}
                onClick={() => props.onSelectPage(p.page_id)}
                className={cn(
                  "rounded-xl border bg-card p-4 text-right transition hover:border-primary/60",
                  p.page_id === selectedPageId ? "border-primary shadow-glow" : "border-border",
                )}
              >
                <div className="mb-1 truncate font-semibold">{p.name}</div>
                <div className="mb-2 text-[11px] text-muted-foreground" dir="ltr">ID: {p.page_id}</div>
                <div className="flex flex-wrap gap-1.5">
                  <ConversationBadge row={p} counting={counting[p.page_id]} />
                  <Badge variant="muted">👥 {fmt(p.fan_count)} متابع</Badge>
                  {p.extracted_count > 0 && <Badge variant="info">📋 {fmt(p.extracted_count)} مستخرج</Badge>}
                  {p.extract_after && !p.extract_done && <Badge variant="warning">⏸️ استخراج غير مكتمل</Badge>}
                  {p.oldest_post_at && (
                    <Badge variant="muted" title="تاريخ أقدم بوست (تقدير لعمر الصفحة)">
                      📅 {new Date(p.oldest_post_at).toLocaleDateString("ar-EG", { year: "numeric", month: "short" })}
                    </Badge>
                  )}
                  {!tokens.has(p.page_id) && !props.tokensLoading && <Badge variant="danger">بدون صلاحية</Badge>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationBadge({ row, counting }: { row: PageRow; counting?: number | undefined }) {
  if (counting !== undefined) return <Badge variant="warning">⏳ جاري العد {fmt(counting)}…</Badge>;
  if (row.conversation_count == null) return <Badge variant="muted">💬 لم يُعد بعد</Badge>;
  return (
    <Badge variant={row.count_complete ? "success" : "warning"} title={row.counted_at ? `آخر عدّ: ${new Date(row.counted_at).toLocaleString("en-US")}` : ""}>
      💬 {fmt(row.conversation_count)} محادثة{row.count_complete ? "" : "+"}
    </Badge>
  );
}

function SelectedPage(p: {
  row: PageRow;
  profileId: string;
  hasToken: boolean;
  counting?: number | undefined;
  extracting?: number | undefined;
  anyExtract: boolean;
  onCount: () => void;
  onExtract: (fresh: boolean) => void;
  onStop: () => void;
  onExport: (t: "json" | "csv") => void;
}) {
  const { row } = p;
  const { data: stats } = useQuery(statsQuery(p.profileId, row.page_id));
  const total = row.conversation_count ?? 0;
  const done = p.extracting ?? row.extracted_count;
  const pct = total ? Math.min(100, (done / total) * 100) : row.extract_done ? 100 : 0;
  const canResume = !!row.extract_after && !row.extract_done;

  return (
    <Panel title={row.name}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Stat label="محادثة" value={row.conversation_count ?? "—"} />
          <Stat label="مستخرج" value={stats?.total ?? row.extracted_count} tone="info" />
          <Stat label="تم الإرسال" value={stats?.sent ?? 0} tone="success" />
        </div>
        <div>
          <Progress value={pct} className="h-1.5" />
          <div className="mt-1 text-[11px] text-muted-foreground">
            {p.extracting !== undefined ? `⏳ استخراج… ${fmt(done)}${total ? " من " + fmt(total) : ""}` : row.extract_done ? "✅ الاستخراج مكتمل" : canResume ? `⏸️ متوقف عند ${fmt(done)}` : "لم يبدأ الاستخراج"}
          </div>
        </div>
        {p.extracting !== undefined ? (
          <Button variant="soft-destructive" className="w-full" onClick={p.onStop}>⏹ إيقاف الاستخراج</Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={!p.hasToken || p.anyExtract} onClick={() => p.onExtract(!canResume)}>
              {canResume ? "⏩ استكمال" : "▶️ استخراج"}
            </Button>
            <Button variant="soft" disabled={!p.hasToken || p.anyExtract} onClick={() => p.onExtract(true)}>
              ↻ من البداية
            </Button>
          </div>
        )}
        <Button variant="soft" className="w-full" disabled={!p.hasToken || p.counting !== undefined} onClick={p.onCount}>
          {p.counting !== undefined ? `⏳ جاري العد ${fmt(p.counting)}…` : "🔢 إعادة عدّ المحادثات"}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="success" onClick={() => p.onExport("json")}>↓ JSON</Button>
          <Button variant="soft" onClick={() => p.onExport("csv")}>↓ CSV</Button>
        </div>
      </div>
    </Panel>
  );
}
