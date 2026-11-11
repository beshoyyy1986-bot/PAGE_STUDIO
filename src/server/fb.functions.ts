import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildBotScript, type BotStatus } from "@/lib/bot-script";
import { conversationUrl } from "@/lib/customer";
import { parseCookies } from "@/lib/cookies";

type Ctx = { supabase: SupabaseClient<Database>; userId: string };

/** Cloud browser credits belong to one owner: the first account that signs in claims the tool. */
async function assertOwner({ supabase, userId }: Ctx) {
  const { data } = await supabase.from("app_owner").select("user_id").maybeSingle();
  if (data) {
    if (data.user_id !== userId) throw new Error("هذا الحساب غير مصرح له باستخدام الأداة");
    return;
  }
  await supabase.from("app_owner").insert({ user_id: userId });
  const { data: again } = await supabase.from("app_owner").select("user_id").maybeSingle();
  if (again?.user_id !== userId) throw new Error("هذا الحساب غير مصرح له باستخدام الأداة");
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────── open sessions ─────────────────────────
export const openSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const { supabase, userId } = context;
    const { openBrowser, closeBrowserVerified } = await import("@/lib/cloudbrowser.server");
    const { CdpConnection } = await import("@/lib/cdp.server");

    const { data: profile, error } = await supabase
      .from("fb_profiles").select("*").eq("id", data.profileId).single();
    if (error || !profile) throw new Error("البروفايل غير موجود");
    const cookies = parseCookies(profile.cookies);

    const label = `fbblaster-${profile.name}-${Date.now()}`;
    const address = await openBrowser(label);
    // Record the browser immediately so it can never stay open untracked.
    const { data: row, error: insErr } = await supabase
      .from("cloud_sessions")
      .insert({ user_id: userId, profile_id: profile.id, address, label, status: "opening" })
      .select().single();
    if (insErr || !row) {
      await closeBrowserVerified(address);
      throw new Error("تعذر تسجيل الجلسة: " + (insErr?.message ?? ""));
    }

    let cdp: InstanceType<typeof CdpConnection> | null = null;
    try {
      cdp = await CdpConnection.connect(address);
      const sid = await cdp.attachPage();
      await cdp.navigate(sid, "https://www.facebook.com/");
      await cdp.send("Network.enable", {}, sid);
      await cdp.send("Network.setCookies", { cookies }, sid);
      await cdp.navigate(sid, profile.fb_url || "https://www.facebook.com/messages");
      const loggedIn = await cdp.evaluate<boolean>(sid, "!document.querySelector('input[name=\"pass\"]')", 10000);
      await supabase.from("cloud_sessions").update({
        status: "open",
        last_error: loggedIn ? null : "يبدو أن الكوكيز لم تسجل الدخول (ظهرت صفحة تسجيل الدخول)",
      }).eq("id", row.id);
      return { ok: true as const, id: row.id, loggedIn };
    } catch (e) {
      const close = await closeBrowserVerified(address);
      await supabase.from("cloud_sessions").update({
        status: close.closed ? "closed" : "close_failed",
        closed_at: close.closed ? new Date().toISOString() : null,
        last_error: `فشل التجهيز: ${errMsg(e)}${close.closed ? "" : " — " + close.detail}`,
      }).eq("id", row.id);
      throw new Error(`فشل تجهيز الجلسة: ${errMsg(e)}`);
    } finally {
      cdp?.close();
    }
  });

// ───────────────────────── send to one conversation ─────────────────────────
export const sendToCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { sessionId: string; customerId: string; checkName: boolean }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const { supabase } = context;
    const { CdpConnection } = await import("@/lib/cdp.server");

    const [{ data: session }, { data: customer }] = await Promise.all([
      supabase.from("cloud_sessions").select("*").eq("id", data.sessionId).single(),
      supabase.from("customers").select("*").eq("id", data.customerId).single(),
    ]);
    if (!session || session.status !== "open") return { status: "session_lost" as const, reason: "الجلسة غير متاحة" };
    if (!customer) return { status: "missing" as const, reason: "العميل غير موجود" };
    if (customer.send_status === "sent") return { status: "sent" as const, reason: "أُرسل سابقاً" };

    const { data: profile } = await supabase.from("fb_profiles").select("fb_url").eq("id", customer.profile_id).single();
    const inbox = profile?.fb_url || "https://www.facebook.com/messages";

    let cdp: InstanceType<typeof CdpConnection>;
    try {
      cdp = await CdpConnection.connect(session.address);
    } catch (e) {
      await supabase.from("cloud_sessions").update({ status: "lost", last_error: errMsg(e) }).eq("id", session.id);
      return { status: "session_lost" as const, reason: errMsg(e) };
    }

    // Mark before acting: if the request dies mid-send we must not resend blindly later.
    await supabase.from("customers").update({
      send_status: "in_progress", attempts: customer.attempts + 1, send_reason: null,
    }).eq("id", customer.id);

    let status: BotStatus | "error" = "error";
    let reason: string | undefined;
    try {
      const sid = await cdp.attachPage();
      await cdp.navigate(sid, conversationUrl(inbox, customer.conversation_id));
      await new Promise((r) => setTimeout(r, 2500));
      const raw = await cdp.evaluate<string>(
        sid,
        buildBotScript({ expectedName: data.checkName ? customer.name : "" }),
        90000,
      );
      const parsed = JSON.parse(raw || "{}") as { status?: BotStatus; reason?: string };
      status = parsed.status ?? "error";
      reason = parsed.reason;
    } catch (e) {
      reason = errMsg(e);
    } finally {
      cdp.close();
    }

    await supabase.from("customers").update({
      send_status: status === "sent" ? "sent" : "failed",
      send_reason: status === "sent" ? null : `${status}: ${reason ?? ""}`,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    }).eq("id", customer.id);
    return { status, reason };
  });

// ───────────────────────── close (verified) ─────────────────────────
export const closeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { sessionId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const { supabase } = context;
    const { closeBrowserVerified } = await import("@/lib/cloudbrowser.server");
    const { data: s } = await supabase.from("cloud_sessions").select("*").eq("id", data.sessionId).single();
    if (!s) throw new Error("الجلسة غير موجودة");
    const r = await closeBrowserVerified(s.address);
    await supabase.from("cloud_sessions").update(
      r.closed
        ? { status: "closed", closed_at: new Date().toISOString(), last_error: null }
        : { status: "close_failed", last_error: r.detail },
    ).eq("id", s.id);
    return r;
  });

// ───────────────────────── reconcile with the service ─────────────────────────
export const syncSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertOwner(context);
    const { supabase, userId } = context;
    const { listBrowsers } = await import("@/lib/cloudbrowser.server");
    const live = await listBrowsers();
    if (!live) throw new Error("تعذر قراءة الجلسات من CloudBrowser");
    const liveSet = new Set(live.map((b) => b.address));

    const { data: rows } = await supabase
      .from("cloud_sessions").select("*").in("status", ["open", "opening", "lost", "close_failed"]);
    const known = new Set((rows ?? []).map((r) => r.address));

    for (const r of rows ?? []) {
      if (!liveSet.has(r.address)) {
        await supabase.from("cloud_sessions").update({
          status: "closed", closed_at: new Date().toISOString(), last_error: r.status === "open" ? "انتهت من جهة الخدمة" : r.last_error,
        }).eq("id", r.id);
      } else if (r.status === "close_failed" || r.status === "opening") {
        // still alive on the account → keep it visible so it can be closed or reused
        await supabase.from("cloud_sessions").update({ status: r.status === "opening" ? "lost" : r.status }).eq("id", r.id);
      }
    }
    // Browsers running on the account that we never recorded (e.g. created by the old tool).
    const orphans = live.filter((b) => !known.has(b.address));
    if (orphans.length) {
      await supabase.from("cloud_sessions").insert(
        orphans.map((b) => ({ user_id: userId, address: b.address, label: b.label || "(غير مسجلة)", status: "lost", last_error: "جلسة مفتوحة على حسابك وغير مسجلة" })),
      );
    }
    return { live: live.length, adopted: orphans.length };
  });

// ───────────────────────── reattach a lost session ─────────────────────────
export const reattachSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { sessionId: string; profileId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const { supabase } = context;
    const { CdpConnection } = await import("@/lib/cdp.server");
    const { data: s } = await supabase.from("cloud_sessions").select("*").eq("id", data.sessionId).single();
    if (!s) throw new Error("الجلسة غير موجودة");
    const cdp = await CdpConnection.connect(s.address).catch((e) => {
      throw new Error("تعذر الاتصال: " + errMsg(e));
    });
    try {
      await cdp.attachPage();
    } finally {
      cdp.close();
    }
    await supabase.from("cloud_sessions").update({ status: "open", profile_id: s.profile_id ?? data.profileId, last_error: null }).eq("id", s.id);
    return { ok: true };
  });

// ───────────────────────── remote view ─────────────────────────
export const startRemoteView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { sessionId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const { cbPost, browserIdFromAddress } = await import("@/lib/cloudbrowser.server");
    const { data: s } = await context.supabase.from("cloud_sessions").select("address").eq("id", data.sessionId).single();
    if (!s) throw new Error("الجلسة غير موجودة");
    const r = await cbPost("/Browser/StartRemoteDesktop", { address: s.address });
    const id = browserIdFromAddress(s.address);
    if (!r.body.success || !r.body.password || !id) throw new Error("تعذر تشغيل العرض المباشر: " + JSON.stringify(r.body).slice(0, 200));
    return { url: `https://browser.cloudbrowser.ai/${id}/${r.body.password}` };
  });

export const whoOwns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      await assertOwner(context);
      return { allowed: true };
    } catch {
      return { allowed: false };
    }
  });
