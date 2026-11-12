import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { FbPage } from "@/lib/facebook";
import {
  PAGE_ROLES,
  addPageToBusiness,
  getBusinessUsers,
  getBusinesses,
  getPageBusiness,
  getPagePeople,
  removePageFromBusiness,
  removePagePerson,
  roleLabel,
  setPagePersonRole,
  type PageRoleKey,
} from "@/lib/fb-business";
import { Panel } from "./Panel";

const selectCls = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";

export function PageManagement({ page, pageName, userToken }: { page: FbPage; pageName: string; userToken: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const owner = useQuery({ queryKey: ["fb-page-biz", page.id], queryFn: () => getPageBusiness(page), staleTime: 60_000 });
  const businesses = useQuery({ queryKey: ["fb-businesses", userToken], queryFn: () => getBusinesses(userToken), staleTime: 120_000, retry: false });
  const people = useQuery({
    queryKey: ["fb-page-people", page.id, owner.data?.id ?? null],
    queryFn: () => getPagePeople(page, userToken, owner.data?.id ?? null),
    enabled: !owner.isLoading,
    retry: false,
  });
  const bizUsers = useQuery({
    queryKey: ["fb-biz-users", owner.data?.id],
    queryFn: () => getBusinessUsers(owner.data!.id, userToken),
    enabled: !!owner.data?.id,
    retry: false,
  });

  async function run(key: string, fn: () => Promise<unknown>, ok: string, refresh: string[][]) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      refresh.forEach((k) => qc.invalidateQueries({ queryKey: k }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const source = people.data?.source;
  const refreshPeople = [["fb-page-people", page.id]];

  // add person
  const [newUser, setNewUser] = useState("");
  const [newRole, setNewRole] = useState<PageRoleKey>("EDITOR");
  // portfolio actions
  const [bizId, setBizId] = useState("");
  const [bizMode, setBizMode] = useState<"owned" | "client">("owned");

  return (
    <Panel title={`إدارة الصفحة — ${pageName}`}>
      <div className="space-y-4 text-xs">
        {/* People */}
        <section className="space-y-2">
          <h4 className="font-semibold">👥 الأشخاص وأدوارهم</h4>
          {people.isLoading && <p className="text-muted-foreground">جاري التحميل…</p>}
          {people.isError && <p className="leading-5 text-destructive">{(people.error as Error).message}<br /><span className="text-muted-foreground">يلزم صلاحية pages_manage_metadata والتوكن لازم يكون لأدمن الصفحة.</span></p>}
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {people.data?.people.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 p-1.5">
                <span className="min-w-0 flex-1 truncate" title={p.id}>{p.name}</span>
                <select
                  className="h-7 w-32 rounded border border-input bg-background px-1 text-[11px]"
                  value={p.role ?? ""}
                  disabled={busy === "role" + p.id}
                  onChange={(e) =>
                    source && run("role" + p.id, () => setPagePersonRole(page, userToken, source, p.id, e.target.value as PageRoleKey), `تم تغيير دور ${p.name}`, refreshPeople)
                  }
                >
                  {p.role === null && <option value="">غير معروف</option>}
                  {PAGE_ROLES.map((r) => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="soft-destructive"
                  className="h-7 px-2"
                  aria-label={`حذف ${p.name}`}
                  disabled={busy === "rm" + p.id}
                  onClick={() => {
                    if (!source || !confirm(`حذف "${p.name}" من الصفحة "${pageName}"؟`)) return;
                    void run("rm" + p.id, () => removePagePerson(page, userToken, source, p.id), `تم حذف ${p.name}`, refreshPeople);
                  }}
                >
                  ✕
                </Button>
              </div>
            ))}
            {people.data && people.data.people.length === 0 && <p className="text-muted-foreground">لا يوجد أشخاص</p>}
          </div>

          <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
            <div className="font-medium text-muted-foreground">➕ إضافة شخص</div>
            {bizUsers.data && bizUsers.data.length > 0 && (
              <select className={selectCls} value="" onChange={(e) => e.target.value && setNewUser(e.target.value)}>
                <option value="">اختر من أشخاص الحافظة…</option>
                {bizUsers.data.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}{u.email ? ` — ${u.email}` : ""}</option>
                ))}
              </select>
            )}
            <Input dir="ltr" className="h-8 text-xs" placeholder="معرّف الشخص (ID)" value={newUser} onChange={(e) => setNewUser(e.target.value)} />
            <div className="flex gap-1.5">
              <select className={selectCls} value={newRole} onChange={(e) => setNewRole(e.target.value as PageRoleKey)}>
                {PAGE_ROLES.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!source || !newUser.trim() || busy === "add"}
                onClick={() =>
                  source &&
                  run("add", () => setPagePersonRole(page, userToken, source, newUser.trim(), newRole), `تمت الإضافة بدور: ${roleLabel(newRole)}`, refreshPeople).then(() => setNewUser(""))
                }
              >
                إضافة
              </Button>
            </div>
          </div>
        </section>

        {/* Portfolios */}
        <section className="space-y-2">
          <h4 className="font-semibold">🗂️ الحافظة</h4>
          <div className="flex items-center gap-2">
            {owner.isLoading ? (
              <span className="text-muted-foreground">جاري التحميل…</span>
            ) : owner.data ? (
              <>
                <Badge variant="info">{owner.data.name}</Badge>
                <Button
                  size="sm"
                  variant="soft-destructive"
                  className="h-7"
                  disabled={busy === "unlink"}
                  onClick={() => {
                    if (!confirm(`إزالة "${pageName}" من الحافظة "${owner.data!.name}"؟`)) return;
                    void run("unlink", () => removePageFromBusiness(owner.data!.id, page.id, userToken), "تمت إزالة الصفحة من الحافظة", [["fb-page-biz", page.id], ["fb-page-people", page.id]]);
                  }}
                >
                  إزالة من الحافظة
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">الصفحة غير مرتبطة بحافظة (أو لا يوجد صلاحية لعرضها)</span>
            )}
          </div>
          <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
            <div className="font-medium text-muted-foreground">➕ إضافة الصفحة لحافظة</div>
            <select className={selectCls} value={bizId} onChange={(e) => setBizId(e.target.value)}>
              <option value="">اختر الحافظة…</option>
              {businesses.data?.map((b) => (
                <option key={b.id} value={b.id}>{b.name}{b.disabled ? " (معطل)" : ""}</option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <select className={selectCls} value={bizMode} onChange={(e) => setBizMode(e.target.value as "owned" | "client")}>
                <option value="owned">ملكية الحافظة (أنا أملك الصفحة)</option>
                <option value="client">طلب وصول كعميل</option>
              </select>
              <Button
                size="sm"
                disabled={!bizId || busy === "link"}
                onClick={() => run("link", () => addPageToBusiness(bizId, page.id, userToken, bizMode), "تمت إضافة الصفحة للحافظة", [["fb-page-biz", page.id], ["fb-page-people", page.id]])}
              >
                إضافة
              </Button>
            </div>
            {businesses.isError && <p className="text-destructive">{(businesses.error as Error).message}</p>}
          </div>
        </section>
      </div>
    </Panel>
  );
}
