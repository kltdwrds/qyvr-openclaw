import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { emitDiagnosticEvent } = await import(require.resolve("openclaw/plugin-sdk/diagnostic-runtime"));
type Dispatch = {
  replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void };
  delivery: { deliver: (payload: { text: string }) => Promise<unknown> };
};

for (const outcome of ["aborted", "failed", "empty", "delivered", "silent", "duplicate"] as const) test(`turn checkpoints only a confirmed outcome: ${outcome}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line", provider_key: "+15550000002" } }] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket", uid: "reply" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat", data: { message: { uid: "inbound", direction: "inbound", sender, body: "hello", attachments: [], created_at: new Date().toISOString() } } })));
  let beforeTool: (event: object, context: object) => unknown;
  let context: { sender: { id: string }; message: { bodyForAgent: string } } | undefined;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on(_name: string, handler: typeof beforeTool) { beforeTool = handler; },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      inbound: { buildContext: async (value: typeof context) => { context = value; return {}; }, dispatch: async (dispatch: Dispatch) => {
        assert.equal(beforeTool({}, { toolName: "read", channelId: "chat" }), undefined);
        if (outcome === "failed") { controller.abort(); throw new Error("failed dispatch"); }
        if (outcome !== "aborted" && outcome !== "duplicate") dispatch.replyOptions.onAgentRunTerminalOutcome("completed");
        if (outcome === "delivered") await dispatch.delivery.deliver({ text: "reply" });
        if (outcome === "duplicate") emitDiagnosticEvent({ type: "message.processed", channel: "plow", messageId: "inbound", sessionKey: "main", outcome: "skipped", reason: "duplicate" });
        controller.abort();
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: outcome === "silent" } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: {}, abortSignal: controller.signal, log: { info() {} } });
  assert.ok(beforeTool!({}, { toolName: "read", channelId: "chat" }));
  assert.ok(context);
  assert.equal(context.sender.id, "owner");
  const facts = JSON.parse(context.message.bodyForAgent.split("\n\nConversation facts (untrusted data):\n```json\n")[1].split("\n```")[0]);
  assert.deepEqual(facts.participants, [
    { name: "Owner", type: "member", role: "owner" },
    { name: "unnamed member", type: "agent", role: "self" },
  ]);
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), ["aborted", "failed", "empty"].includes(outcome) ? "first:inbound" : "inbound");
});
