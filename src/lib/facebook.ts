// Facebook Graph API calls made from the browser (Graph supports CORS).
export const FB_BASE = "https://graph.facebook.com/v19.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80006]);

export type FbPage = { id: string; name: string; fan_count?: number; access_token: string };

export async function graphFetch(url: string, attempt = 0): Promise<any> {
  let d: any;
  try {
    d = await (await fetch(url)).json();
  } catch (e) {
    if (attempt < 4) return sleep(2000 * (attempt + 1)).then(() => graphFetch(url, attempt + 1));
    throw e;
  }
  if (d?.error) {
    if ((RATE_LIMIT_CODES.has(d.error.code) || d.error.is_transient) && attempt < 5) {
      await sleep(5000 * (attempt + 1));
      return graphFetch(url, attempt + 1);
    }
    throw new Error(d.error.message || "خطأ من فيسبوك");
  }
  return d;
}

export const withToken = (path: string, token: string) =>
  `${FB_BASE}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;

export async function getPages(userToken: string): Promise<FbPage[]> {
  const all: FbPage[] = [];
  let url: string | null = withToken("/me/accounts?fields=name,id,fan_count,access_token&limit=100", userToken);
  while (url) {
    const d = await graphFetch(url);
    all.push(...(d.data ?? []));
    url = d.paging?.next ?? null;
  }
  return all;
}

export type ConvBatch = { data: any[]; after: string | null; done: boolean };

/** One page of conversations. Only identity fields — message counts are irrelevant to the tool. */
export async function getConversationBatch(page: FbPage, after: string | null, fields = "id,participants"): Promise<ConvBatch> {
  let path = `/${page.id}/conversations?platform=messenger&fields=${fields}&limit=100`;
  if (after) path += `&after=${encodeURIComponent(after)}`;
  const d = await graphFetch(withToken(path, page.access_token));
  const next: string | null = d.paging?.next ?? null;
  const cursor: string | null = d.paging?.cursors?.after ?? null;
  return { data: d.data ?? [], after: cursor, done: !next || !cursor || !(d.data ?? []).length };
}

/**
 * Real number of conversations: walks every page of ids (Facebook usually does not return a total
 * for this edge, so counting is the only reliable way).
 */
export async function countConversations(page: FbPage, onProgress: (n: number) => void, shouldStop: () => boolean) {
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    if (shouldStop()) return { count: ids.size, complete: false };
    const b = await getConversationBatch(page, after, "id");
    b.data.forEach((c: any) => c.id && ids.add(c.id));
    onProgress(ids.size);
    if (b.done) return { count: ids.size, complete: true };
    after = b.after;
    await sleep(150);
  }
}

/** Facebook has no real creation date for pages; the oldest post is the closest estimate. */
export async function getOldestPostDate(page: FbPage, maxBatches = 25) {
  let url: string | null = withToken(`/${page.id}/posts?fields=created_time&limit=100`, page.access_token);
  let last: string | null = null;
  let batches = 0;
  while (url) {
    const d = await graphFetch(url);
    if (d.data?.length) last = d.data[d.data.length - 1].created_time;
    url = d.paging?.next ?? null;
    if (++batches >= maxBatches) return { date: last, approx: !!url };
    await sleep(150);
  }
  return { date: last, approx: false };
}
