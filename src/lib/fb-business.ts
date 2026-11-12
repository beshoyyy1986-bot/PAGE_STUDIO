// Business portfolios, ad accounts and page-people management through the Graph API (browser-side).
import { FB_BASE, graphFetch, withToken, type FbPage } from "./facebook";

export type Tone = "success" | "danger" | "warning" | "muted";

/* ---------------- pure helpers (unit-tested) ---------------- */

export const PAGE_ROLES = [
  { key: "ADMIN", label: "أدمن (تحكم كامل)", tasks: ["MANAGE", "CREATE_CONTENT", "MODERATE", "MESSAGING", "ADVERTISE", "ANALYZE"] },
  { key: "EDITOR", label: "محرر", tasks: ["CREATE_CONTENT", "MODERATE", "MESSAGING", "ADVERTISE", "ANALYZE"] },
  { key: "MODERATOR", label: "مشرف (رسائل وتعليقات)", tasks: ["MODERATE", "MESSAGING", "ADVERTISE", "ANALYZE"] },
  { key: "ADVERTISER", label: "معلن", tasks: ["ADVERTISE", "ANALYZE"] },
  { key: "ANALYST", label: "محلل", tasks: ["ANALYZE"] },
] as const;
export type PageRoleKey = (typeof PAGE_ROLES)[number]["key"];

const LEGACY_ROLE: Record<string, PageRoleKey> = {
  ADMIN: "ADMIN", MANAGER: "ADMIN",
  EDITOR: "EDITOR", CONTENT_CREATOR: "EDITOR",
  MODERATOR: "MODERATOR",
  ADVERTISER: "ADVERTISER",
  ANALYST: "ANALYST", INSIGHTS_ANALYST: "ANALYST",
};

/** The highest role that a set of Facebook tasks (or an old role name) corresponds to. */
export function roleFromTasks(tasks: readonly string[] | undefined, legacyRole?: string): PageRoleKey | null {
  const t = new Set((tasks ?? []).map((x) => x.toUpperCase()));
  if (t.has("MANAGE")) return "ADMIN";
  if (t.has("CREATE_CONTENT")) return "EDITOR";
  if (t.has("MODERATE")) return "MODERATOR";
  if (t.has("ADVERTISE")) return "ADVERTISER";
  if (t.has("ANALYZE")) return "ANALYST";
  if (legacyRole) return LEGACY_ROLE[legacyRole.toUpperCase().replace(/\s+/g, "_")] ?? null;
  return null;
}

export const roleTasks = (key: PageRoleKey) => [...PAGE_ROLES.find((r) => r.key === key)!.tasks];
export const roleLabel = (key: PageRoleKey | null) => PAGE_ROLES.find((r) => r.key === key)?.label ?? "دور غير معروف";

/** Facebook ad account_status codes → label shown next to the account. */
export function adAccountStatus(code: number): { label: string; tone: Tone; disabled: boolean } {
  switch (code) {
    case 1:
    case 201:
      return { label: "نشط", tone: "success", disabled: false };
    case 2:
      return { label: "معطل", tone: "danger", disabled: true };
    case 3:
      return { label: "معطل — مديونية غير مدفوعة", tone: "danger", disabled: true };
    case 7:
      return { label: "قيد المراجعة", tone: "warning", disabled: false };
    case 8:
      return { label: "بانتظار التسوية", tone: "warning", disabled: false };
    case 9:
      return { label: "فترة سماح", tone: "warning", disabled: false };
    case 100:
      return { label: "قيد الإغلاق", tone: "danger", disabled: true };
    case 101:
    case 202:
      return { label: "مغلق", tone: "danger", disabled: true };
    default:
      return { label: "غير معروف", tone: "muted", disabled: false };
  }
}

const DISABLE_REASONS: Record<number, string> = {
  1: "مخالفة سياسات الإعلانات",
  2: "مراجعة حقوق ملكية",
  3: "مشكلة في الدفع",
  4: "إغلاق حساب مشبوه",
  5: "مراجعة الإعلانات",
  6: "تقييد على النشاط التجاري",
  7: "إغلاق نهائي",
  8: "حساب موزع غير مستخدم",
  9: "حساب غير مستخدم",
};
export const disableReasonLabel = (r?: number | null) => (r ? DISABLE_REASONS[r] ?? `سبب رقم ${r}` : "");

/* ---------------- Graph calls ---------------- */

async function graphAll(path: string, token: string, max = 50): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = withToken(path, token);
  for (let i = 0; url && i < max; i++) {
    const d = await graphFetch(url);
    out.push(...(d.data ?? []));
    url = d.paging?.next ?? null;
  }
  return out;
}

async function graphSend(method: "POST" | "DELETE", path: string, token: string, params: Record<string, string>) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(method === "DELETE" ? `${FB_BASE}${path}?${body}` : `${FB_BASE}${path}`, method === "DELETE" ? { method } : { method, body });
  const d = await res.json().catch(() => ({}));
  if (d?.error) throw new Error(d.error.error_user_msg || d.error.message || "خطأ من فيسبوك");
  if (d?.success === false) throw new Error("فيسبوك رفض العملية");
  return d;
}

export type Business = { id: string; name: string; disabled: boolean | null; adTotal: number; adDisabled: number; verification?: string };

/**
 * Facebook does not expose a "disabled" flag for portfolios to normal tokens, so a portfolio counts as
 * disabled when it has ad accounts and every one of them is disabled (that is what a restricted
 * portfolio looks like). No ad accounts → active.
 */
export function businessStatusFromAds(statuses: number[]): boolean {
  return statuses.length > 0 && statuses.every((s) => adAccountStatus(s).disabled);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

export async function getBusinesses(userToken: string): Promise<Business[]> {
  const rows = await graphAll("/me/businesses?fields=id,name,verification_status&limit=100", userToken);
  return mapLimit(rows, 5, async (b) => {
    try {
      const ads = await graphAll(`/${b.id}/owned_ad_accounts?fields=account_status&limit=200`, userToken, 5);
      const statuses = ads.map((a) => a.account_status as number);
      return {
        id: b.id,
        name: b.name,
        verification: b.verification_status,
        adTotal: statuses.length,
        adDisabled: statuses.filter((s) => adAccountStatus(s).disabled).length,
        disabled: businessStatusFromAds(statuses),
      };
    } catch {
      return { id: b.id, name: b.name, verification: b.verification_status, adTotal: 0, adDisabled: 0, disabled: null };
    }
  });
}

export type AdAccount = { id: string; accountId: string; name: string; status: number; disableReason: number | null; currency?: string };

export async function getAdAccounts(userToken: string): Promise<AdAccount[]> {
  const rows = await graphAll("/me/adaccounts?fields=id,account_id,name,account_status,disable_reason,currency&limit=100", userToken);
  return rows.map((a) => ({ id: a.id, accountId: a.account_id, name: a.name || a.account_id, status: a.account_status, disableReason: a.disable_reason ?? null, currency: a.currency }));
}

/** The portfolio that owns the page, when Facebook reports it. */
export async function getPageBusiness(page: FbPage): Promise<{ id: string; name: string } | null> {
  try {
    const d = await graphFetch(withToken(`/${page.id}?fields=business{id,name}`, page.access_token));
    return d.business ? { id: d.business.id, name: d.business.name } : null;
  } catch {
    return null;
  }
}

export async function addPageToBusiness(businessId: string, pageId: string, userToken: string, mode: "owned" | "client") {
  if (mode === "owned") return graphSend("POST", `/${businessId}/owned_pages`, userToken, { page_id: pageId });
  return graphSend("POST", `/${businessId}/client_pages`, userToken, {
    page_id: pageId,
    permitted_tasks: JSON.stringify(roleTasks("ADMIN")),
  });
}

export async function removePageFromBusiness(businessId: string, pageId: string, userToken: string) {
  return graphSend("DELETE", `/${businessId}/pages`, userToken, { page_id: pageId });
}

export type BusinessUser = { id: string; name: string; email?: string };
export async function getBusinessUsers(businessId: string, userToken: string): Promise<BusinessUser[]> {
  const rows = await graphAll(`/${businessId}/business_users?fields=id,name,email&limit=100`, userToken);
  return rows.map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

/* ---------------- people on a page ---------------- */

export type PagePerson = { id: string; name: string; role: PageRoleKey | null; tasks: string[] };
export type PeopleSource = { kind: "roles" } | { kind: "business"; businessId: string };

/**
 * People with access to the page. Classic pages expose /roles; pages in a business portfolio expose
 * /assigned_users for that portfolio. Tries both and reports which one answered.
 */
export async function getPagePeople(page: FbPage, userToken: string, businessId: string | null): Promise<{ source: PeopleSource; people: PagePerson[] }> {
  let firstError: unknown = null;
  try {
    const rows = await graphAll(`/${page.id}/roles?fields=id,name,tasks&limit=100`, page.access_token, 10);
    return { source: { kind: "roles" }, people: rows.map((r) => ({ id: r.id, name: r.name, tasks: r.tasks ?? [], role: roleFromTasks(r.tasks) })) };
  } catch (e) {
    firstError = e;
  }
  if (businessId) {
    const rows = await graphAll(`/${page.id}/assigned_users?business=${businessId}&fields=id,name,tasks&limit=100`, userToken, 10);
    return { source: { kind: "business", businessId }, people: rows.map((r) => ({ id: r.id, name: r.name, tasks: r.tasks ?? [], role: roleFromTasks(r.tasks) })) };
  }
  throw firstError instanceof Error ? firstError : new Error("تعذر جلب الأشخاص");
}

/** Adds a person or changes their role (same call on Facebook's side). */
export async function setPagePersonRole(page: FbPage, userToken: string, source: PeopleSource, user: string, role: PageRoleKey) {
  const tasks = JSON.stringify(roleTasks(role));
  if (source.kind === "roles") return graphSend("POST", `/${page.id}/roles`, page.access_token, { user, tasks });
  return graphSend("POST", `/${page.id}/assigned_users`, userToken, { user, tasks, business: source.businessId });
}

export async function removePagePerson(page: FbPage, userToken: string, source: PeopleSource, user: string) {
  if (source.kind === "roles") return graphSend("DELETE", `/${page.id}/roles`, page.access_token, { user });
  return graphSend("DELETE", `/${page.id}/assigned_users`, userToken, { user, business: source.businessId });
}
