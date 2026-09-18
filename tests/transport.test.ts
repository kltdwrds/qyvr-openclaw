import assert from "node:assert/strict";
import { test } from "node:test";
import { recover, type Account, type Message } from "../plugin/transport.ts";

const account = { apiBase: "http://fixture", accountId: "chat" } as Account;
const message = (uid: string) => ({ uid }) as Message;

test("recovery walks older pages to the checkpoint and replays oldest first", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(url.includes("starting_after=newer")
      ? { data: [message("missed"), message("acked"), message("old")], has_more: true }
      : { data: [message("newest"), message("newer")], has_more: true });
  });
  assert.deepEqual((await recover(account, "chat", "acked")).map(m => m.uid), ["missed", "newer", "newest"]);
  assert.deepEqual(urls, ["http://fixture/v1/chats/chat/messages?limit=50", "http://fixture/v1/chats/chat/messages?limit=50&starting_after=newer"]);
});

test("empty first-install checkpoint still recovers the first missed message", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [message("first")], has_more: false }));
  assert.deepEqual((await recover(account, "chat", "")).map(m => m.uid), ["first"]);
});

test("a failed history read cannot masquerade as an empty recovery", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(recover(account, "chat", "acked"), /HTTP 503/);
});

for (const outcome of ["completed", "incomplete"] as const) test(`unknown delivery advances once; next turn ${outcome} during abort`, async t => {
  const { createRequire } = await import("node:module");
  const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { listen, DeliveryUnknownError } = await import("../plugin/transport.ts");
  const root = await mkdtemp(`${tmpdir()}/plow-delivery-`);
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const fixture = { ...account, apiBase: `http://127.0.0.1:${server.address().port}`, lineUid: "line" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const uid of ["uncertain", "next"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: "chat", data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const calls: string[] = [];
  try {
    await listen(fixture, controller.signal, () => {}, async (_chat, message) => {
      calls.push(message.uid);
      if (message.uid === "uncertain") throw new DeliveryUnknownError();
      controller.abort();
      return outcome;
    });
    assert.deepEqual(calls, ["uncertain", "next"]);
    assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), outcome === "completed" ? "next" : "uncertain");
  } finally {
    clearTimeout(timeout);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  }
});

for (const scenario of ["waited", "pending", "answered", "peer", "group"]) test(`first contact and restart: ${scenario}`, async t => {
  const { createRequire } = await import("node:module");
  const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { listen } = await import("../plugin/transport.ts");
  const root = await mkdtemp(`${tmpdir()}/plow-contact-`);
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "test-token";
  if (scenario === "waited") {
    await mkdir(`${root}/plow-checkpoints`);
    await writeFile(`${root}/plow-checkpoints/home`, "");
  }
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  const fixture = { ...account, apiBase: `http://127.0.0.1:${server.address().port}`, lineUid: "line", homeChatUid: scenario === "group" ? "other" : "home" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const chat = { uid: "home", status: "active", participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const first = { uid: "first", body: "What is 17 + 25?", direction: scenario === "answered" ? "outbound" : "inbound",
    sender: scenario === "peer" ? { type: "agent", relationship: "peer", line: { uid: "peer" } } : sender };
  const older = { ...first, uid: "older" };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: url.includes("limit=1") || scenario === "waited" ? [first] : [first, older], has_more: false } : { ticket: "ticket" }));
  const turns: { uid: string; firstContact: boolean }[] = [];
  try {
    for (let boot = 0; boot < 2; boot++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      await listen(fixture, controller.signal, () => {}, async (_chat, message, firstContact) => {
        turns.push({ uid: message.uid, firstContact });
        return "completed";
      });
      clearTimeout(timeout);
      assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), "first");
    }
    assert.deepEqual(turns, ["waited", "pending"].includes(scenario) ? [{ uid: "first", firstContact: true }] : []);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  }
});

test("first-contact recovery includes its message and newer arrivals, excluding older history", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [message("newer"), message("pending"), message("old")], has_more: false,
  }));
  assert.deepEqual((await recover(account, "home", "first:pending")).map(m => m.uid), ["pending", "newer"]);
});

for (const failure of ["incomplete", "throws"] as const) test(`a turn that ${failure} is acked without disconnecting or replaying later turns`, async t => {
  const { createRequire } = await import("node:module");
  const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { listen } = await import("../plugin/transport.ts");
  const root = await mkdtemp(`${tmpdir()}/plow-incomplete-`);
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  const fixture = { ...account, apiBase: `http://127.0.0.1:${server.address().port}`, lineUid: "line" };
  const chats = ["home", "other"].map(uid => ({ uid, status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
  ] }));
  const messages = ["unfinished", "later"].map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  let recovering = false;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: recovering && url.includes("/home/") ? [...messages].reverse() : [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  let connections = 0;
  server.on("connection", (socket: { send: (text: string) => void }) => {
    connections++;
    if (recovering) return;
    for (const [chat, message] of [["home", messages[0]], ["home", messages[1]], ["other", { ...messages[1], uid: "other-reply" }]] as const) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat, data: { message } }));
    }
  });
  try {
    for (const phase of ["live", "recovery"]) {
      recovering = phase === "recovery";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const calls: string[] = [];
      const logs: string[] = [];
      const priorCheckpoints: string[] = [];
      try {
        await listen(fixture, controller.signal, text => {
          logs.push(text);
          if (text.startsWith("transport stopped")) controller.abort();
        }, async (_chat, message) => {
          calls.push(message.uid);
          if (message.uid === "later") priorCheckpoints.push(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
          if (!recovering && message.uid === "unfinished") {
            if (failure === "throws") throw new Error("turn failed");
            return "incomplete";
          }
          if (message.uid === (recovering ? "later" : "other-reply")) controller.abort();
          return "completed";
        });
      } finally { clearTimeout(timeout); }
      assert.deepEqual(calls, recovering ? [] : ["unfinished", "later", "other-reply"]);
      assert.deepEqual(priorCheckpoints, recovering ? [] : ["unfinished"]);
      assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), "later");
      assert.equal(await readFile(`${root}/plow-checkpoints/other`, "utf8"), "other-reply");
      assert.equal(connections, recovering ? 2 : 1);
      assert.ok(!logs.some(text => text.startsWith("transport stopped")));
      if (!recovering) assert.ok(logs.some(text => text.includes("turn incomplete chat=home message=unfinished")));
    }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  }
});
