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

const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");

for (const scenario of ["restart", 0, 2] as const) test(`boot starts existing chats immediately and holds a socket only for first contact: ${scenario}`, { timeout: 20_000 }, async t => {
  const restart = scenario === "restart";
  const drops = restart ? 0 : scenario;
  const root = await mkdtemp(join(tmpdir(), "plow-boot-"));
  const boot = new URL("../boot/", import.meta.url);
  for (const name of await readdir(boot)) {
    if (!name.endsWith(".ts")) continue;
    const source = (await readFile(new URL(name, boot), "utf8"))
      .replaceAll("/var/lib/plow", `${root}/state`).replaceAll("/opt/plow/prompt/AGENTS.md", `${root}/prompt.md`);
    await writeFile(join(root, name.replace(/\.ts$/, ".js")), stripTypeScriptTypes(source.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
  }
  await writeFile(join(root, "process.js"), 'export async function startGateway() { console.log("GATEWAY_STARTED"); }');
  await writeFile(join(root, "prompt.md"), "Test instructions");
  if (restart) {
    await mkdir(`${root}/state/plow-checkpoints`, { recursive: true });
    await writeFile(`${root}/state/plow-checkpoints/cht_probe`, "already-acked");
  }
  const calls: { method: string; path: string; time: number; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method!, path: request.url!, time: performance.now(), authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/ws/ticket" ? { ticket: "boot-ticket" } :
      restart || calls.filter(call => call.path === "/v1/agents/me").length > 1 ? probeIdentity : { line: { uid: "line" }, chats: [] }));
    server.emit("requested");
    if (request.url === "/v1/agents/me") server.emit("identity");
  });
  const sockets = new WebSocketServer({ server });
  let connections = 0;
  sockets.on("connection", (socket: { send: (text: string) => void; close: () => void }) => {
    socket.send(JSON.stringify({ type: "connected" }));
    if (++connections <= drops) socket.close();
    else server.emit("held", socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requested = once(server, "requested");
  const held = once(server, "held");
  const child = spawn(process.execPath, [join(root, "main.js")], {
    env: { PLOW_API_BASE: `http://127.0.0.1:${address.port}`, PLOW_AGENT_TOKEN: "boot-fixture" },
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
  await Promise.race([requested, closed.then(() => assert.fail(stderr))]);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/v1/agents/me");
  if (restart) {
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes("GATEWAY_STARTED"));
    assert.equal(calls.length, 1);
    assert.equal(connections, 0);
    assert.equal(await readFile(`${root}/state/plow-checkpoints/cht_probe`, "utf8"), "already-acked");
    return;
  }
  const [socket] = await held;
  socket.send(JSON.stringify({ event_type: "message_sent", data: { message: { direction: "outbound" } } }));
  await sleep(6_000);
  assert.equal(connections, drops + 1);
  assert.equal(calls.length, drops + 2, "quiet sockets must not poll identity or mint more tickets");
  const tickets = calls.filter(call => call.path === "/v1/ws/ticket");
  assert.ok(tickets.every(call => call.path === "/v1/ws/ticket" && call.authorization === "Bearer boot-fixture"));
  if (drops) {
    assert.ok(tickets[1].time - tickets[0].time >= 1_000);
    assert.ok(tickets[2].time - tickets[1].time >= 2_000);
  }
  const identity = once(server, "identity");
  socket.send(JSON.stringify({ event_type: "message_received", chat_id: "cht_probe", data: { message: { uid: "msg_first", direction: "inbound" } } }));
  await identity;
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("GATEWAY_STARTED"));
  assert.equal(await readFile(`${root}/state/plow-checkpoints/cht_probe`, "utf8"), "first:msg_first");
  assert.equal(calls.filter(call => call.path === "/v1/agents/me").length, 2);
  assert.equal(connections, drops + 1);
});
