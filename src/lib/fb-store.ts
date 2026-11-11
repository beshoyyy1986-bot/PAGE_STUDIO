import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Customer } from "@/lib/customer";

export const profilesQuery = () =>
  queryOptions({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("fb_profiles").select("*").order("created_at");
      if (error) throw error;
      return data;
    },
  });

export const pagesQuery = (profileId: string | undefined) =>
  queryOptions({
    queryKey: ["pages", profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const { data, error } = await supabase.from("fb_pages").select("*").eq("profile_id", profileId!).order("name");
      if (error) throw error;
      return data;
    },
  });

export type StatusCounts = { total: number; pending: number; sent: number; failed: number; in_progress: number };

async function countWhere(profileId: string, pageId: string, status?: string) {
  let q = supabase.from("customers").select("id", { count: "exact", head: true }).eq("profile_id", profileId).eq("page_id", pageId);
  if (status) q = q.eq("send_status", status);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export const statsQuery = (profileId: string | undefined, pageId: string | undefined) =>
  queryOptions({
    queryKey: ["stats", profileId, pageId],
    enabled: !!profileId && !!pageId,
    queryFn: async (): Promise<StatusCounts> => {
      const [total, pending, sent, failed, in_progress] = await Promise.all([
        countWhere(profileId!, pageId!),
        countWhere(profileId!, pageId!, "pending"),
        countWhere(profileId!, pageId!, "sent"),
        countWhere(profileId!, pageId!, "failed"),
        countWhere(profileId!, pageId!, "in_progress"),
      ]);
      return { total, pending, sent, failed, in_progress };
    },
  });

export const sessionsQuery = () =>
  queryOptions({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cloud_sessions")
        .select("*")
        .in("status", ["opening", "open", "lost", "close_failed"])
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });

export async function upsertCustomers(userId: string, profileId: string, pageId: string, list: Customer[]) {
  for (let i = 0; i < list.length; i += 500) {
    const rows = list.slice(i, i + 500).map((c) => ({
      user_id: userId,
      profile_id: profileId,
      page_id: pageId,
      conversation_id: c.conversationId,
      participant_id: c.participantId,
      name: c.name,
    }));
    // send_status is not in the payload, so re-extracting never resets who was already sent to.
    const { error } = await supabase.from("customers").upsert(rows, { onConflict: "profile_id,page_id,conversation_id" });
    if (error) throw error;
  }
}

export async function countCustomers(profileId: string, pageId: string) {
  return countWhere(profileId, pageId);
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export function fetchCustomersForExport(profileId: string, pageId: string) {
  return fetchAll((from, to) =>
    supabase
      .from("customers")
      .select("conversation_id,participant_id,name,send_status")
      .eq("profile_id", profileId)
      .eq("page_id", pageId)
      .order("created_at")
      .range(from, to),
  );
}

export function fetchQueue(profileId: string, pageId: string, statuses: string[]) {
  return fetchAll((from, to) =>
    supabase
      .from("customers")
      .select("id,name,conversation_id")
      .eq("profile_id", profileId)
      .eq("page_id", pageId)
      .in("send_status", statuses)
      .order("created_at")
      .range(from, to),
  );
}
