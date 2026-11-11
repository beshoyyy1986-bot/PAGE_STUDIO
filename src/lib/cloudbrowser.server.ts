// Server-only client for the CloudBrowser REST API (open / close / list / remote view).
const CB_API = "https://production.cloudbrowser.ai/api/v1";

export type CbResult = { httpStatus: number; body: Record<string, unknown>; networkError?: string };

function apiKey(): string {
  const key = process.env["CLOUDBROWSER_API_KEY"];
  if (!key) throw new Error("مفتاح CloudBrowser غير مضبوط على السيرفر");
  return key;
}

async function call(path: string, init: RequestInit): Promise<CbResult> {
  try {
    const r = await fetch(CB_API + path, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    });
    const text = await r.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { httpStatus: r.status, body };
  } catch (e) {
    return { httpStatus: 0, body: {}, networkError: e instanceof Error ? e.message : String(e) };
  }
}

export const cbPost = (path: string, body: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const cbGet = (path: string) => call(path, { method: "GET" });

export type CbBrowser = { address: string; label: string; startedOn?: string };

/** Live browsers on the account. Returns null when the service could not be read. */
export async function listBrowsers(): Promise<CbBrowser[] | null> {
  const r = await cbGet("/Browser/Get");
  if (r.httpStatus !== 200 || !Array.isArray(r.body["browsers"])) return null;
  return (r.body["browsers"] as Record<string, unknown>[]).map((b) => ({
    address: String(b["address"] ?? b["Address"] ?? ""),
    label: String(b["label"] ?? b["Label"] ?? ""),
    startedOn: b["startedOn"] ? String(b["startedOn"]) : undefined,
  }));
}

export async function openBrowser(label: string) {
  const r = await cbPost("/Browser/Open", { label, keepOpen: 0, headless: false, stealth: true });
  const address = typeof r.body["address"] === "string" ? r.body["address"] : null;
  if (r.httpStatus !== 200 || !address) {
    throw new Error(`فشل فتح المتصفح السحابي: ${r.networkError ?? JSON.stringify(r.body).slice(0, 300)}`);
  }
  return address;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Closes a cloud browser and confirms it is gone from the account list.
 * The Close endpoint answers success even for unknown addresses, so its reply alone proves nothing.
 */
export async function closeBrowserVerified(address: string): Promise<{ closed: boolean; detail: string }> {
  const r = await cbPost("/Browser/Close", { address });
  if (r.httpStatus !== 200 || r.body["success"] === false) {
    return { closed: false, detail: `رد الإغلاق: ${r.networkError ?? JSON.stringify(r.body).slice(0, 200)}` };
  }
  for (let i = 0; i < 4; i++) {
    const list = await listBrowsers();
    if (list && !list.some((b) => b.address === address)) return { closed: true, detail: "ok" };
    await sleep(1200);
  }
  return { closed: false, detail: "الخدمة قبلت الإغلاق لكن المتصفح ما زال يظهر في حسابك" };
}

export function browserIdFromAddress(address: string): string | null {
  const m = address.match(/\/browser\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}
