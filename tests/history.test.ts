import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

test("a new group turn receives its outbound opener once, in chronological context", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const self = { type: "agent", relationship: "self", line: { uid: "line", display_name: "Willow" } };
  const sender = { type: "member", uid: "member", role: "member", display_name: "Guest" };
  const chat = { uid: "group", status: "active", trusted: true, participants: [self, sender, { ...sender, uid: "owner", role: "owner" }] };
  const message = (uid: string, body: string, author = sender) => ({ uid, body, sender: author, direction: "inbound", attachments: [], created_at: "2026-09-19T12:00:00Z" });
  const opener = { ...message("opener", "I'm Flicker. Lunch at Pine Cafe: 12:30 or 12:45?"), sender: self, direction: "outbound" };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [], has_more: false } : url.endsWith("/chats/group") ? chat :
    url.includes("/messages?") ? { data: [opener, message("older", "Let's plan lunch")], has_more: true } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const msg of [message("reply", "Let's do 12:45"), message("thanks", "Thanks")])
      socket.send(JSON.stringify({ event_type: "message_received", event_id: msg.uid, chat_id: chat.uid, data: { message: msg } }));
  });
  const contexts: { message: { bodyForAgent: string; inboundHistory?: unknown[] } }[] = [];
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } };
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "group" }) },
      inbound: {
        buildContext: async (value: typeof contexts[number]) => { contexts.push(value); return {}; },
        dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
          replyOptions.onAgentRunTerminalOutcome("completed");
          if (contexts.length === 2) controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  await channel!.gateway.startAccount({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg: {}, abortSignal: controller.signal });
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[0].message.inboundHistory, [
    { sender: "Guest", body: "Let's plan lunch", timestamp: Date.parse(opener.created_at), messageId: "older" },
    { sender: "You (assistant)", body: opener.body, timestamp: Date.parse(opener.created_at), messageId: "opener" },
  ]);
  assert.deepEqual(contexts[1].message.inboundHistory, []);
  assert.deepEqual(fetch.mock.calls.map(call => String(call.arguments[0])).filter(url => url.includes("/messages?")),
    [`${apiBase}/v1/chats/group/messages?limit=20&starting_after=reply`]);
  const facts = JSON.parse(contexts[0].message.bodyForAgent.split("```json\n")[1].split("\n```")[0]);
  assert.deepEqual(facts.participants[0], { type: "agent", role: "self" });
});
