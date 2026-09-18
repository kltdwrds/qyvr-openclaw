import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";

for (const mode of ["full", "discovery", "tool-discovery"]) test(`${mode} registers the policy and denies a call without a message requester`, async () => {
  let beforeTool: ((event: unknown, context: unknown) => unknown) | undefined;
  entry.register({
    registrationMode: mode,
    registerChannel() {}, runtime: {},
    registerTool() {}, logger: { info() {} },
    on(name: string, handler: typeof beforeTool) { if (name === "before_tool_call") beforeTool = handler; },
  });
  assert.ok(beforeTool, "tool discovery must carry the authorization hook");
  for (const toolName of ["read", "exec", "plow_start_thread", "plow_send_message"]) assert.deepEqual(await beforeTool({}, { toolName }), {
    block: true, blockReason: "This tool requires the owner.",
  });
  assert.deepEqual(await beforeTool({}, { toolName: "plow_tool" }), {
    block: true, blockReason: "Tools require the owner or a trusted conversation.",
  });
});

for (const served of [true, false]) test(`host-originated send checks account reach: served=${served}`, async t => {
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> } } | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  assert.ok(channel);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return Response.json(url.endsWith("/messages") ? { uid: "sent" } : {
      uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: served ? "line" : "other" } }],
    });
  });
  const result = channel.outbound.sendText({ cfg: { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } }, accountId: "chat", to: "chat", text: "recovered reply" });
  if (served) {
    assert.deepEqual(await result, { channel: "plow", messageId: "sent" });
    assert.deepEqual(requests, ["http://fixture/v1/chats/chat", "http://fixture/v1/chats/chat/messages"]);
  } else {
    await assert.rejects(result, /does not serve/);
    assert.deepEqual(requests, ["http://fixture/v1/chats/chat"]);
  }
});

test("start-thread refuses a home without an owner handle", async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_start_thread") factory = value; } });
  assert.ok(factory);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return Response.json({ participants: [] }); });
  const tool = factory({ config: { channels: { plow: { apiBase: "http://fixture", lineUid: "line", homeChatUid: "home" } } } });
  await assert.rejects(tool.execute("call", { members: ["+15550000002"], body: "Meet Friday?" }), /no owner handle/);
  assert.deepEqual(calls, ["http://fixture/v1/chats/home"]);
});

test("start-thread returns a tool error without config and makes no request", async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_start_thread") factory = value; } });
  assert.ok(factory);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  assert.deepEqual(await factory({}).execute("call", { members: ["+15550000002"], body: "Hi" }), {
    isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
  });
  assert.equal(fetch.mock.callCount(), 0);
});

for (const status of [200, 403, 503, "unserved"] as const) test(`send-message checks reach and reports only confirmed sends: ${status}`, async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_send_message") factory = value; } });
  assert.ok(factory);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const posts: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body as string));
      return Response.json({ uid: "sent-message" }, { status: status === "unserved" ? 200 : status });
    }
    return Response.json({ uid: "target", status: "active", participants: [
      { type: "agent", relationship: "self", line: { uid: status === "unserved" ? "other-line" : "line" } },
    ] });
  });
  const tool = factory({ config: { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } } });
  const result = tool.execute("call", { chat_uid: "target", body: "Friday at noon." });
  if (status === 200) assert.deepEqual((await result as { details: unknown }).details,
    { chat_uid: "target", message_uid: "sent-message", message_sent: true });
  else await assert.rejects(result, status === "unserved" ? /does not serve/ : status === 503 ? /delivery is unknown/ : /HTTP 403/);
  assert.deepEqual(posts, status === "unserved" ? [] : [{ body: "Friday at noon.", attachment_uids: [] }]);
  assert.deepEqual(await factory({}).execute("call", { chat_uid: "target", body: "Hello" }), {
    isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
  });
});
