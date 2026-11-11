import { describe, expect, it } from "vitest";
import { conversationUrl, extractCustomer, parseCustomerFile, uniqueByConversation } from "@/lib/customer";
import { buildBotScript, SAVED_REPLY_MARKER } from "@/lib/bot-script";
import { normalizeCdpAddress } from "@/lib/cdp.server";
import { parseCookies } from "@/lib/cookies";

describe("customer identity", () => {
  it("keeps conversation id and participant id as separate fields", () => {
    const c = extractCustomer(
      { id: "t_555", participants: { data: [{ id: "PAGE", name: "Page" }, { id: "999", name: "Ali" }] } },
      "PAGE",
    );
    expect(c).toEqual({ conversationId: "t_555", participantId: "999", name: "Ali" });
  });

  it("ignores message counts entirely — the record has no message fields", () => {
    const c = extractCustomer(
      { id: "t_1", message_count: 40, participants: { data: [{ id: "u1", name: "A" }] } } as never,
      "PAGE",
    );
    expect(Object.keys(c!).sort()).toEqual(["conversationId", "name", "participantId"]);
  });

  it("counts one customer per conversation, not per name", () => {
    const list = uniqueByConversation([
      { conversationId: "t_1", participantId: "a", name: "Sara" },
      { conversationId: "t_1", participantId: "a", name: "Sara" },
      { conversationId: "t_2", participantId: "b", name: "Sara" },
    ]);
    expect(list).toHaveLength(2);
  });

  it("opens the conversation by its conversation id, not the person id", () => {
    expect(conversationUrl("https://www.facebook.com/messages/", "t_555")).toBe("https://www.facebook.com/messages/t/555");
  });

  it("skips file rows that have no conversation id", () => {
    const r = parseCustomerFile("a.csv", 'id,name\n123,"Old row"\n');
    expect(r.customers).toHaveLength(0);
    expect(r.missingConversationId).toBe(1);
    const r2 = parseCustomerFile("b.json", JSON.stringify([{ conversationId: "t_9", participantId: "7", name: "N" }]));
    expect(r2.customers[0]).toEqual({ conversationId: "t_9", participantId: "7", name: "N" });
  });
});

describe("sending", () => {
  it("only sends the saved reply named BM AUTO", () => {
    expect(SAVED_REPLY_MARKER).toBe("BM AUTO");
    expect(buildBotScript({})).toContain('"marker":"BM AUTO"');
  });

  it("connects to the cloud browser over wss even when the service returns ws://", () => {
    expect(normalizeCdpAddress("ws://browser.cloudbrowser.ai/68/devtools/browser/abc")).toBe(
      "wss://browser.cloudbrowser.ai/68/devtools/browser/abc",
    );
  });

  it("rejects cookies that cannot log in (missing c_user or xs)", () => {
    expect(() => parseCookies("c_user=1")).toThrow();
    expect(parseCookies("c_user=1; xs=abc")).toHaveLength(2);
  });
});
