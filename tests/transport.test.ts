import assert from "node:assert/strict";
import { test } from "node:test";
import { websocketFixture } from "./ws-fixture.ts";
import fs, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { listen, DeliveryUnknownError, recover, type Account, type Message } from "../plugin/transport.ts";

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

test("a truncated chat listing warns and keeps recovery and live delivery on the same connection", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/group`, "old");
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const missed = { uid: "missed", direction: "inbound", sender: { type: "member" } };
  let connections = 0;
  server.on("connection", () => { connections++; });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: true } :
    url.endsWith("/chats/group") ? chat :
    url.endsWith("/messages?limit=50") ? { data: [missed, { uid: "old" }], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const received: string[] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => logs.push(text), async (_chat, message) => {
    received.push(message.uid);
    if (message.uid === "missed") {
      for (const socket of server.clients) socket.send(JSON.stringify({
        event_type: "message_received", event_id: "live", chat_id: chat.uid, data: { message: { ...missed, uid: "live" } },
      }));
    } else controller.abort();
    return "completed";
  });
  assert.deepEqual(received, ["missed", "live"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), "live");
  assert.equal(connections, 1);
  assert.ok(logs.some(text => text.includes("warning") && text.includes("truncated")));
  assert.ok(!logs.some(text => text.startsWith("transport stopped:")));
});

test("a frame arriving while a synthesized checkpoint is written is recovered", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const message = { uid: "arriving", direction: "inbound", sender: { type: "member" } };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
    url.includes("/messages?") ? { data: [message], has_more: false } : { ticket: "ticket" }));
  const originalWrite = fs.writeFile;
  let injected = false;
  const writer = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!injected && String(args[0]).endsWith("/group.tmp") && args[1] === message.uid) {
      injected = true;
      for (const socket of server.clients) {
        socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: chat.uid, data: { message } }));
        await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
      }
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line", ownerChatUid: "home" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    controller.abort();
    return "completed";
  });
  assert.equal(injected, true);
  assert.deepEqual(received, [message.uid]);
  assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), message.uid);
});

test("recovery beyond the seen cache does not replay buffered frames or rewind the checkpoint", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/group`, "old");
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const messages = Array.from({ length: 514 }, (_, i) => ({ uid: `message-${i}`, direction: "inbound", sender: { type: "member" } }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/messages?")) for (const socket of server.clients) {
      for (const message of [messages[0], { ...messages[0], uid: "live" }]) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
      await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
      url.includes("/messages?") ? { data: [...messages].reverse(), has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    if (message.uid === "live") {
      assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), messages.at(-1)!.uid);
      controller.abort();
    }
    received.push(message.uid);
    return "completed";
  });
  assert.deepEqual(received, [...messages.map(message => message.uid), "live"]);
});

for (const outcome of ["completed", "incomplete"] as const) test(`unknown delivery advances once; next turn ${outcome} during abort`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const fixture = { ...account, apiBase, lineUid: "line" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const uid of ["uncertain", "next"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: "chat", data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const calls: string[] = [];
  await listen(fixture, controller.signal, () => {}, async (_chat, message) => {
    calls.push(message.uid);
    if (message.uid === "uncertain") throw new DeliveryUnknownError();
    controller.abort();
    return outcome;
  });
  assert.deepEqual(calls, ["uncertain", "next"]);
  assert.equal(fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).length, 0, "unknown delivery never sends another message");
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), outcome === "completed" ? "next" : "uncertain");
});

for (const scenario of ["waited", "pending", "buffered", "answered", "peer", "group"]) test(`first contact and restart: ${scenario}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  if (scenario === "waited") {
    await mkdir(`${root}/plow-checkpoints`);
    await writeFile(`${root}/plow-checkpoints/home`, "");
  }
  const fixture = { ...account, apiBase, lineUid: "line", ownerChatUid: scenario === "group" ? "other" : "home" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const chat = { uid: "home", status: "active", participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const first = { uid: "first", body: "What is 17 + 25?", direction: scenario === "answered" ? "outbound" : "inbound",
    sender: scenario === "peer" ? { type: "agent", relationship: "peer", line: { uid: "peer" } } : sender };
  const older = { ...first, uid: "older" };
  if (scenario === "buffered") server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "first", chat_id: "home", data: { message: first } })));
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: url.includes("limit=1") || scenario === "waited" ? [first] : [first, older], has_more: false } : { ticket: "ticket" }));
  const turns: { uid: string; firstContact: boolean }[] = [];
  for (let boot = 0; boot < 2; boot++) {
    const controller = abortAfter();
    await listen(fixture, controller.signal, () => {}, async (_chat, message, firstContact) => {
      turns.push({ uid: message.uid, firstContact });
      return "completed";
    });
    assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), "first");
  }
  assert.deepEqual(turns, ["waited", "pending", "buffered"].includes(scenario) ? [{ uid: "first", firstContact: true }] : []);
});

test("first-contact recovery includes its message and newer arrivals, excluding older history", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [message("newer"), message("pending"), message("old")], has_more: false,
  }));
  assert.deepEqual((await recover(account, "home", "first:pending")).map(m => m.uid), ["pending", "newer"]);
});

for (const failure of ["incomplete", "throws", "notice-unknown"] as const) test(`a turn that ${failure} is acked without disconnecting or replaying later turns`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const fixture = { ...account, apiBase, lineUid: "line" };
  const chats = ["home", "other"].map(uid => ({ uid, status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
  ] }));
  const messages = ["unfinished", "later"].map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  let recovering = false;
  const notices: { url: string; body: string; checkpoint: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "POST" && url.endsWith("/messages")) {
      notices.push({ url, body: JSON.parse(options.body as string).body,
        checkpoint: await readFile(`${root}/plow-checkpoints/home`, "utf8") });
      if (failure === "notice-unknown") throw new TypeError("connection lost after sending notice");
      return Response.json({ uid: "notice" });
    }
    return Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: recovering && url.includes("/home/") ? [...messages].reverse() : [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" });
  });
  let connections = 0;
  server.on("connection", (socket: { send: (text: string) => void }) => {
    connections++;
    if (recovering) return;
    for (const [chat, message] of [["home", messages[0]], ["home", messages[1]], ["other", { ...messages[1], uid: "other-reply" }]] as const) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat, data: { message } }));
    }
  });
  for (const phase of ["live", "recovery"]) {
    recovering = phase === "recovery";
    const controller = abortAfter();
    const calls: string[] = [];
    const logs: string[] = [];
    const priorCheckpoints: string[] = [];
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
    assert.deepEqual(calls, recovering ? [] : ["unfinished", "later", "other-reply"]);
    assert.deepEqual(priorCheckpoints, recovering ? [] : ["unfinished"]);
    assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), "later");
    assert.equal(await readFile(`${root}/plow-checkpoints/other`, "utf8"), "other-reply");
    assert.equal(connections, recovering ? 2 : 1);
    assert.equal(notices.length, 1, "one notice attempt, with no replay after restart or uncertain notice delivery");
    assert.equal(notices[0].checkpoint, "unfinished");
    assert.equal(notices[0].url, `${apiBase}/v1/chats/home/messages`);
    assert.match(notices[0].body, /part.*may have.*(?:happened|gone through)/i);
    assert.match(notices[0].body, /check before resending/i);
    assert.ok(!logs.some(text => text.startsWith("transport stopped")));
    if (!recovering) assert.ok(logs.some(text => text.includes("turn incomplete chat=home message=unfinished")));
  }
});

test("a new chat's message arriving during listing is buffered by the socket", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "new-chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) {
      for (const socket of server.clients) socket.send(JSON.stringify({
        event_type: "message_received", event_id: "new-event", chat_id: chat.uid,
        data: { message: { uid: "new-message", direction: "inbound", sender: { type: "member" } } },
      }));
      return Response.json({ data: [], has_more: false });
    }
    return Response.json(url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    controller.abort();
    return "completed";
  });
  assert.deepEqual(received, ["new-message"]);
});

for (const count of [1, 2]) for (const arrival of ["listing", "baseline"] as const) test(`${count} existing chat frames arriving during ${arrival} are delivered in order without replaying history`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const messages = ["old", "first", "second"].slice(0, count + 1).map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (arrival === "listing" ? url.endsWith("/chats") : url.includes("limit=1")) {
      for (const socket of server.clients) {
        for (const message of messages.slice(1)) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
        // Wait for a round trip so the frames reach the client before the snapshot.
        await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
      }
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?")
        ? { data: url.includes("limit=1") ? messages.slice(-1) : [...messages].reverse(), has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line", ownerChatUid: "home" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    if (received.length === count) controller.abort();
    return "completed";
  });
  assert.deepEqual(received, messages.slice(1).map(message => message.uid));
  assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), messages.at(-1)!.uid);
});

test("an omitted checkpointed chat recovers before its first live frame advances progress", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/omitted`, "old");
  const chat = { uid: "omitted", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const incoming = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" } });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [], has_more: true } :
    url.endsWith("/chats/omitted") ? chat :
    url.includes("limit=50") ? { data: [incoming("live"), incoming("missed"), incoming("old")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "live-event", chat_id: chat.uid, data: { message: incoming("live") },
  })));
  const delivered: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    delivered.push(message.uid);
    if (message.uid === "live") controller.abort();
    return "completed";
  });
  assert.deepEqual(delivered, ["missed", "live"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/omitted`, "utf8"), "live");
});

test("optional history failure still dispatches the message with empty history", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const inbound = { uid: "inbound", direction: "inbound", sender: { type: "member" } };
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=20")) return ++historyReads === 1
      ? new Response(null, { status: 503 })
      : Response.json({ data: [inbound], has_more: false });
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "event", chat_id: chat.uid, data: { message: inbound },
  })));
  const delivered: string[] = [];
  const histories: Message[][] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("acked") && delivered.length === 2) controller.abort();
  }, async (_chat, message, _first, history) => {
    delivered.push(message.uid);
    histories.push(history);
    if (delivered.length === 1) for (const socket of server.clients) socket.send(JSON.stringify({
      event_type: "message_received", event_id: "second", chat_id: chat.uid, data: { message: { ...inbound, uid: "second" } },
    }));
    return "completed";
  });
  assert.deepEqual(delivered, ["inbound", "second"]);
  assert.equal(historyReads, 2);
  assert.deepEqual(histories, [[], [inbound]]);
  assert.ok(logs.some(text => text.includes("history") && text.includes("failed")));
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), "second");
});

test("reconnecting does not re-inject history into an already contextualized chat", { timeout: 40_000 }, async t => {
  const { server, apiBase } = await websocketFixture(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); });
  const chat = { uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  let historyReads = 0;
  let connections = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=20")) historyReads++;
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    const uid = String(++connections);
    socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat.uid,
      data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const delivered: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    delivered.push(message.uid);
    if (delivered.length === 1) for (const socket of server.clients) socket.close();
    else controller.abort();
    return "completed";
  });
  assert.deepEqual(delivered, ["1", "2"]);
  assert.equal(historyReads, 1);
});
