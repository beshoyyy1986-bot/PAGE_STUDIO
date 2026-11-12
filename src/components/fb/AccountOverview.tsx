import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  adAccountStatus,
  disableReasonLabel,
  getAdAccounts,
  getBusinesses,
} from "@/lib/fb-business";

const fmt = (n: number) => n.toLocaleString("en-US");

export function AccountOverview({ token, pagesCount }: { token: string; pagesCount: number }) {
  const biz = useQuery({
    queryKey: ["fb-businesses", token],
    queryFn: () => getBusinesses(token),
    enabled: !!token,
    staleTime: 120_000,
    retry: false,
  });
  const ads = useQuery({
    queryKey: ["fb-adaccounts", token],
    queryFn: () => getAdAccounts(token),
    enabled: !!token,
    staleTime: 120_000,
    retry: false,
  });

  if (!token) return null;
  const bList = biz.data ?? [];
  const aList = ads.data ?? [];
  const bOff = bList.filter((b) => b.disabled).length;
  const aOff = aList.filter((a) => adAccountStatus(a.status).disabled).length;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs">
      <Badge variant="info">📄 {fmt(pagesCount)} صفحة</Badge>

      <Popover>
        <PopoverTrigger asChild>
          <button className="rounded-md" aria-label="الحافظات">
            <Badge variant={biz.isError ? "danger" : "muted"} className="cursor-pointer">
              🗂️{" "}
              {biz.isLoading
                ? "…"
                : biz.isError
                  ? "تعذر جلب الحافظات"
                  : `${fmt(bList.length)} حافظة أعمال`}
              {bOff > 0 && <span className="ms-1 text-destructive">({fmt(bOff)} معطل)</span>}
              <span className="ms-1">▾</span>
            </Badge>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-72 overflow-y-auto p-2 text-xs">
          {biz.isError && <p className="p-2 text-destructive">{(biz.error as Error).message}</p>}
          {bList.length > 0 && (
            <p className="px-2 pb-1 text-[10px] text-muted-foreground">
              الحافظة "معطل" = كل حساباتها الإعلانية معطلة (فيسبوك لا يعطي حالة الحافظة مباشرة)
            </p>
          )}
          {!biz.isError && bList.length === 0 && (
            <p className="p-2 text-muted-foreground">لا توجد حافظات</p>
          )}
          {bList.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent"
            >
              <span className="min-w-0">
                <span className="block truncate">{b.name}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {b.adTotal
                    ? `${fmt(b.adTotal)} حساب إعلاني${b.adDisabled ? ` · ${fmt(b.adDisabled)} معطل` : ""}`
                    : "بدون حسابات إعلانية"}
                </span>
              </span>
              {b.disabled === null ? (
                <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                  —
                </Badge>
              ) : b.disabled ? (
                <Badge variant="danger" className="shrink-0 px-1.5 py-0 text-[10px]">
                  معطل
                </Badge>
              ) : (
                <Badge variant="success" className="shrink-0 px-1.5 py-0 text-[10px]">
                  نشط
                </Badge>
              )}
            </div>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button className="rounded-md" aria-label="الحسابات الإعلانية">
            <Badge variant={ads.isError ? "danger" : "muted"} className="cursor-pointer">
              📢{" "}
              {ads.isLoading
                ? "…"
                : ads.isError
                  ? "تعذر جلب الحسابات الإعلانية"
                  : `${fmt(aList.length)} حساب إعلاني`}
              {aOff > 0 && <span className="ms-1 text-destructive">({fmt(aOff)} معطل)</span>}
              <span className="ms-1">▾</span>
            </Badge>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-80 overflow-y-auto p-2 text-xs">
          {ads.isError && <p className="p-2 text-destructive">{(ads.error as Error).message}</p>}
          {!ads.isError && aList.length === 0 && (
            <p className="p-2 text-muted-foreground">لا توجد حسابات إعلانية</p>
          )}
          {aList.map((a) => {
            const s = adAccountStatus(a.status);
            const why = s.disabled ? disableReasonLabel(a.disableReason) : "";
            return (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent"
                title={why}
              >
                <span className="min-w-0">
                  <span className="block truncate">{a.name}</span>
                  <span className="block text-[10px] text-muted-foreground" dir="ltr">
                    {a.accountId}
                    {why ? ` · ${why}` : ""}
                  </span>
                </span>
                <Badge
                  variant={
                    s.tone === "muted"
                      ? "muted"
                      : s.tone === "danger"
                        ? "danger"
                        : s.tone === "warning"
                          ? "warning"
                          : "success"
                  }
                  className="shrink-0 px-1.5 py-0 text-[10px]"
                >
                  {s.label}
                </Badge>
              </div>
            );
          })}
        </PopoverContent>
      </Popover>

      {(biz.isError || ads.isError) && (
        <span className="text-[11px] text-muted-foreground">
          التوكن غالبًا ينقصه صلاحية business_management / ads_read
        </span>
      )}
    </div>
  );
}
