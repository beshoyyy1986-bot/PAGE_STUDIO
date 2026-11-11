// Minimal Chrome DevTools Protocol client over WebSocket, usable from the Worker runtime
// and from Node during development. Each call opens a short-lived connection, so no
// in-memory session state is needed between requests.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

interface MinimalSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, cb: (ev: any) => void): void;
}

/** CloudBrowser returns ws:// addresses that only answer with a redirect to wss://. */
export function normalizeCdpAddress(address: string): string {
  return address.replace(/^ws:\/\//i, "wss://");
}

async function openSocket(address: string): Promise<MinimalSocket> {
  const wss = normalizeCdpAddress(address);
  const g = globalThis as any;
  if (typeof g.WebSocketPair !== "undefined") {
    // Worker runtime: outbound WebSockets go through fetch with an Upgrade header.
    const res = await fetch(wss.replace(/^wss:\/\//i, "https://"), { headers: { Upgrade: "websocket" } });
    const ws = (res as any).webSocket;
    if (!ws) throw new Error(`تعذر الاتصال بالمتصفح السحابي (HTTP ${res.status})`);
    ws.accept();
    return ws as MinimalSocket;
  }
  const ws = new WebSocket(wss);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("انتهت مهلة الاتصال بالمتصفح السحابي")), 15000);
    ws.addEventListener("open", () => (clearTimeout(t), resolve()));
    ws.addEventListener("error", () => (clearTimeout(t), reject(new Error("تعذر الاتصال بالمتصفح السحابي"))));
  });
  return ws as unknown as MinimalSocket;
}

export class CdpConnection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private constructor(private ws: MinimalSocket) {
    ws.addEventListener("message", async (ev: any) => {
      const raw = typeof ev.data === "string" ? ev.data : await new Response(ev.data).text();
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
        else p.resolve(msg.result);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("انقطع الاتصال بالمتصفح السحابي"));
      this.pending.clear();
    });
  }

  static async connect(address: string) {
    return new CdpConnection(await openSocket(address));
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("الاتصال مغلق"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`انتهت المهلة: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId) msg["sessionId"] = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Attaches to the first normal tab, creating one if the browser has none. */
  async attachPage(): Promise<string> {
    const { targetInfos } = await this.send<{ targetInfos: { targetId: string; type: string }[] }>(
      "Target.getTargets",
    );
    let target = targetInfos.find((t) => t.type === "page");
    let targetId = target?.targetId;
    if (!targetId) {
      targetId = (await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    }
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async evaluate<T = unknown>(sessionId: string, expression: string, timeoutMs = 60000): Promise<T> {
    const r = await this.send<any>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "خطأ في تنفيذ السكريبت");
    }
    return r.result?.value as T;
  }

  /** Navigates and waits until the document has loaded (or the timeout passes). */
  async navigate(sessionId: string, url: string, timeoutMs = 30000) {
    const r = await this.send<any>("Page.navigate", { url }, sessionId, timeoutMs);
    if (r?.errorText) throw new Error(`فشل فتح الرابط: ${r.errorText}`);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((res) => setTimeout(res, 500));
      try {
        const state = await this.evaluate<string>(sessionId, "document.readyState", 5000);
        if (state === "complete" || state === "interactive") return;
      } catch {
        /* page still swapping documents */
      }
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
