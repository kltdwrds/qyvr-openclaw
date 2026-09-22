import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { probeIdentity } from "../boot/probe-fixture.ts";

const packageUrl = new URL("../plugin/package.json", import.meta.url);
const { WebSocketServer } = createRequire(packageUrl)("ws");

for (const scenario of ["restart", "401", "503", "silent", "early", "no-owner", "quiet", "drops", "buffered", "wake-503"] as const)
test(`socket-first boot: ${scenario}`, { timeout: 200_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-boot-"));
  const boot = new URL("../boot/", import.meta.url);
  for (const name of await readdir(boot)) {
    if (!name.endsWith(".ts")) continue;
    const source = (await readFile(new URL(name, boot), "utf8"))
      .replaceAll("/var/lib/plow", `${root}/state`).replaceAll("/opt/plow/prompt/AGENTS.md", `${root}/prompt.md`)
      .replaceAll('"../plugin/package.json"', JSON.stringify(packageUrl.href));
    await writeFile(join(root, name.replace(/\.ts$/, ".js")), stripTypeScriptTypes(source.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
  }
  await writeFile(join(root, "process.js"), `
    import { listen } from ${JSON.stringify(new URL("../plugin/transport.ts", import.meta.url).href)};
    export async function startGateway() {
      console.log("GATEWAY_STARTED");
      if (${JSON.stringify(scenario)} !== "early") return;
      const abort = new AbortController();
      await listen({ apiBase: process.env.PLOW_API_BASE, accountId: "chat", lineUid: "ln_probe", ownerChatUid: "cht_probe" },
        abort.signal, console.log, async (_chat, message) => {
          await fetch(process.env.PLOW_API_BASE + "/reply/" + message.uid, { method: "POST" });
          if (message.uid === "second") abort.abort();
          return "completed";
        });
    }
  `);
  await writeFile(join(root, "prompt.md"), "Test instructions");
  if (scenario === "restart") {
    await mkdir(`${root}/state/plow-checkpoints`, { recursive: true });
    await writeFile(`${root}/state/plow-checkpoints/cht_probe`, "already-acked");
  }
  const calls: { path: string; time: number }[] = [];
  const replies: string[] = [];
  let owner = ["restart", "401", "503"].includes(scenario);
  let identityReads = 0;
  let connections = 0;
  const started = performance.now();
  const message = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" }, body: uid });
  const server = createServer((request, response) => {
    calls.push({ path: request.url!, time: performance.now() });
    response.setHeader("Content-Type", "application/json");
    let body: unknown = {};
    if (request.url === "/v1/ws/ticket") body = { ticket: "boot-ticket" };
    if (request.url === "/v1/agents/me") {
      identityReads++;
      if (scenario === "401" && performance.now() - started < 60_000) response.statusCode = 401;
      if (scenario === "503" && identityReads === 1) response.statusCode = 503;
      body = owner ? probeIdentity : { line: { uid: "ln_probe" }, chats: [] };
      if (scenario === "wake-503" && identityReads === 2) response.statusCode = 503;
      if (scenario === "buffered" && identityReads === 1) {
        owner = true;
        for (const socket of sockets.clients) socket.send(JSON.stringify({
          event_type: "message_received", chat_id: "cht_probe", data: { message: message("during-identity") },
        }));
      }
    }
    if (request.url === "/v1/chats") body = { data: probeIdentity.chats, has_more: false };
    if (request.url === "/v1/chats/cht_probe") body = probeIdentity.chats[0];
    if (request.url?.includes("/messages?")) body = {
      data: request.url.includes("limit=20") ? [] : [message("second"), message("before-subscribe")], has_more: false,
    };
    if (request.url?.startsWith("/reply/")) replies.push(request.url.split("/").at(-1)!);
    response.end(JSON.stringify(body));
    if (request.url === "/v1/agents/me") server.emit("identity");
  });
  const sockets = new WebSocketServer({ server, autoPong: scenario !== "silent" });
  sockets.on("connection", (socket: { send: (text: string) => void; close: () => void }) => {
    connections++;
    if (scenario === "drops" && connections <= 2) { socket.close(); return; }
    socket.send(JSON.stringify({ type: "connected" }));
    server.emit("held", socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const held = once(server, "held");
  const firstIdentity = once(server, "identity");
  const child = spawn(process.execPath, [join(root, "main.js")], {
    env: { PLOW_API_BASE: `http://127.0.0.1:${address.port}`, PLOW_AGENT_TOKEN: "boot-fixture", OPENCLAW_STATE_DIR: `${root}/state` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    child.kill(); await closed;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await firstIdentity;
  assert.equal(calls[0].path, "/v1/ws/ticket", "subscribe before identity");
  let [socket] = await held;
  if (!owner) {
    socket.send(JSON.stringify({ event_type: "message_sent", data: { message: { direction: "outbound" } } }));
    if (scenario === "quiet") {
      await sleep(180_000);
      assert.equal(identityReads, 1, "180 seconds parked: zero identity reads after boot success");
      assert.equal(connections, 1, "healthy pongs keep the original socket");
      t.diagnostic("180 seconds parked: initial identity reads=1; subsequent identity reads=0; connections=1");
    }
    if (scenario === "silent") {
      const reconnected = once(server, "held");
      [socket] = await reconnected;
      assert.ok(performance.now() - started < 65_000, "missed pong reconnects by second 30-second heartbeat plus backoff");
      assert.equal(identityReads, 1, "reconnect never polls identity");
    }
    if (scenario === "no-owner" || scenario === "wake-503") {
      const checked = once(server, "identity");
      socket.send(JSON.stringify({ event_type: "message_received", chat_id: "other", data: { message: message("unrelated") } }));
      await checked;
      await sleep(100);
      assert.equal(identityReads, 2);
      assert.ok(!stderr.includes("parked"), stderr);
      assert.ok(!stdout.includes("GATEWAY_STARTED"));
    }
    owner = true;
    socket.send(JSON.stringify({ event_type: "message_received", chat_id: "cht_probe", data: { message: message("second") } }));
  }
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("GATEWAY_STARTED"), stdout);
  if (scenario !== "401" && scenario !== "503") {
    assert.equal(await readFile(`${root}/state/plow-checkpoints/cht_probe`, "utf8"),
      scenario === "restart" ? "already-acked" : scenario === "early" ? "second" : "");
  }
  if (scenario === "early") assert.deepEqual(replies, ["before-subscribe", "second"]);
  if (scenario === "401") { assert.ok(identityReads > 1); assert.ok(performance.now() - started >= 60_000); }
  if (scenario === "503") assert.equal(identityReads, 2);
  if (scenario === "drops") {
    const tickets = calls.filter(call => call.path === "/v1/ws/ticket");
    assert.ok(tickets[1].time - tickets[0].time >= 1_000);
    assert.ok(tickets[2].time - tickets[1].time >= 2_000);
  }
  t.diagnostic(`gateway started; identity reads=${identityReads}; connections=${connections}; replies=${JSON.stringify(replies)}`);
});
