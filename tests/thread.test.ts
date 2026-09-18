import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import entry from "../plugin/index.ts";

const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");
type Tool = { name: string; execute: (id: string, args: object) => Promise<unknown> };

for (const toolName of ["plow_start_thread", "plow_send_message"]) {
  for (const status of [200, 403, 408, 424, 503, "network"] as const) test(`${toolName}: per-turn delivery state, status=${status}`, async t => {
    const root = await mkdtemp(`${tmpdir()}/plow-thread-`);
    process.env.OPENCLAW_STATE_DIR = root;
    process.env.PLOW_AGENT_TOKEN = "test-token";
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.on("listening", resolve));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const account = { apiBase: `http://127.0.0.1:${server.address().port}`, accountId: "chat", lineUid: "line", homeChatUid: "home" };
    const cfg = { channels: { plow: account } };
    const sender = { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" };
    const chat = { uid: "home", status: "active", participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
    const posts: Record<string, unknown>[] = [];
    const results: unknown[] = [], errors: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      if (options.method === "POST" && (url.endsWith("/chats") || url.endsWith("/messages"))) {
        posts.push(JSON.parse(options.body as string));
        if (status === "network") throw new TypeError("network error");
        return Response.json({ uid: "created" }, { status });
      }
      return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
        url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
    });
    server.on("connection", (socket: { send: (text: string) => void }) => {
      for (const uid of ["first-request", "later-identical-request"]) socket.send(JSON.stringify({
        event_type: "message_received", event_id: uid, chat_id: "home",
        data: { message: { uid, direction: "inbound", sender, body: "Start a group", attachments: [], created_at: new Date().toISOString() } },
      }));
    });
    let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
    let tool: Tool;
    let turns = 0;
    entry.register({ registrationMode: "full", logger: { info() {} }, on() {},
      registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
      registerTool(factory: (context: object) => Tool) { const candidate = factory({ config: cfg }); if (candidate.name === toolName) tool = candidate; },
      runtime: { channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) }, inbound: {
        buildContext: async () => ({}), dispatch: async () => {
          for (let retry = 0; retry < 2; retry++) {
            try { results.push(await tool.execute(`call-${retry}`, { members: ["+15550000002", "+15550000001"], chat_uid: "home", body: "Meet Friday?" })); }
            catch (error) { errors.push((error as Error).message); }
          }
          if (++turns === 2) controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      } } },
    });
    try {
      await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
      assert.equal(turns, 2);
      assert.equal(posts.length, status === 200 || status === 403 ? 4 : 2);
      if (status === 200) {
        assert.equal(results.length, 4);
        if (toolName === "plow_start_thread") {
          assert.deepEqual(posts[0].members, ["+15550000001", "+15550000002"]);
          assert.equal(posts[0].trusted, false);
          assert.equal(posts[0].line_uid, "line");
          assert.equal(posts[0].body, "Meet Friday?");
          assert.equal(posts[0].idempotency_key, posts[1].idempotency_key);
          assert.equal(posts[2].idempotency_key, posts[3].idempotency_key);
          assert.notEqual(posts[0].idempotency_key, posts[2].idempotency_key);
          assert.deepEqual((results[0] as { details: unknown }).details, { chat_uid: "created", message_sent: true });
        }
      } else {
        assert.equal(results.length, 0);
        assert.equal(errors.length, 4);
        assert.ok(errors.every(error => status === 403 ? error.includes("HTTP 403") : error.includes("delivery is unknown")));
      }
    } finally {
      clearTimeout(timeout);
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(resolve));
      await rm(root, { recursive: true });
    }
  });
}
