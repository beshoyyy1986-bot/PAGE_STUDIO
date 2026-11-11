export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/** Accepts a JSON array (browser-extension export), {cookies: [...]}, or a "c_user=..; xs=.." string. */
export function parseCookies(raw: string): BrowserCookie[] {
  const text = raw.trim();
  if (!text) throw new Error("الكوكيز فارغة");
  type RawCookie = { name?: unknown; value?: unknown; domain?: unknown; path?: unknown; httpOnly?: unknown; secure?: unknown; sameSite?: unknown };
  let list: RawCookie[] | null = null;
  try {
    const p = JSON.parse(text);
    if (Array.isArray(p)) list = p;
    else if (Array.isArray(p?.cookies)) list = p.cookies;
  } catch {
    /* not JSON */
  }
  if (!list) {
    if (!text.includes("=")) throw new Error("صيغة كوكيز غير معروفة");
    list = text.split(";").map((pair) => {
      const [n, ...rest] = pair.trim().split("=");
      return { name: n?.trim(), value: rest.join("=").trim() };
    });
  }
  const out = list
    .map((c) => {
      const s = String(c.sameSite ?? "").toLowerCase();
      const sameSite: BrowserCookie["sameSite"] = s === "strict" ? "Strict" : s === "lax" ? "Lax" : "None";
      return {
        name: String(c.name ?? "").trim(),
        value: String(c.value ?? ""),
        domain: String(c.domain || ".facebook.com"),
        path: String(c.path || "/"),
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
        sameSite,
      };
    })
    .filter((c) => c.name && c.value);
  if (!out.length) throw new Error("لم يتم العثور على كوكيز صالحة");
  if (!out.some((c) => c.name === "c_user") || !out.some((c) => c.name === "xs")) {
    throw new Error("الكوكيز ناقصة: لازم تحتوي على c_user و xs");
  }
  return out;
}
