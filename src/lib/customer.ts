// Customer records are keyed by the real conversation, never by message counts or who wrote first.

export type Customer = {
  conversationId: string;
  participantId: string;
  name: string;
};

type GraphConversation = {
  id?: string;
  participants?: { data?: { id?: string; name?: string }[] };
};

/** Picks the person in a page conversation; returns null when the conversation has no id or no customer. */
export function extractCustomer(conv: GraphConversation, pageId: string): Customer | null {
  if (!conv.id) return null;
  const person = (conv.participants?.data ?? []).find((p) => p.id && p.id !== pageId);
  if (!person?.id) return null;
  return { conversationId: conv.id, participantId: person.id, name: person.name?.trim() || "بدون اسم" };
}

/** Keeps one record per conversation (the goal is the page's real conversation count). */
export function uniqueByConversation<T extends { conversationId: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.conversationId) ? false : (seen.add(c.conversationId), true)));
}

/** Graph conversation ids look like "t_123"; the inbox URL uses the part after the prefix. */
export function threadKey(conversationId: string): string {
  return conversationId.replace(/^t_/, "");
}

export function conversationUrl(inboxUrl: string, conversationId: string): string {
  return `${inboxUrl.replace(/\/+$/, "")}/t/${threadKey(conversationId)}`;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export type ParsedFile = { customers: Customer[]; missingConversationId: number };

/** Reads an exported JSON/CSV file. Rows without a conversation id cannot be sent and are counted separately. */
export function parseCustomerFile(fileName: string, text: string): ParsedFile {
  type RawRow = { conversationId?: unknown; conversation_id?: unknown; participantId?: unknown; participant_id?: unknown; id?: unknown; name?: unknown };
  let rows: RawRow[];
  if (fileName.toLowerCase().endsWith(".csv")) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
    const header = splitCsvLine(lines[0] ?? "");
    rows = lines.slice(1).map((l) => {
      const cols = splitCsvLine(l);
      return Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""])) as RawRow;
    });
  } else {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("الملف يجب أن يكون قائمة (JSON array)");
    rows = parsed;
  }
  let missing = 0;
  const customers: Customer[] = [];
  for (const r of rows) {
    const conversationId = String(r.conversationId ?? r.conversation_id ?? "").trim();
    if (!conversationId) {
      missing++;
      continue;
    }
    customers.push({
      conversationId,
      participantId: String(r.participantId ?? r.participant_id ?? r.id ?? "").trim(),
      name: String(r.name ?? "").trim() || "بدون اسم",
    });
  }
  return { customers: uniqueByConversation(customers), missingConversationId: missing };
}

export function toCsv(list: Customer[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ["conversationId,participantId,name", ...list.map((c) => `${esc(c.conversationId)},${esc(c.participantId)},${esc(c.name)}`)].join("\n");
}
