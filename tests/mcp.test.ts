import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

for (const mode of ["json", "sse", "failure", "expired", "redirect"] as const) test(`HTTP bridge forwards MCP without replay: ${mode}`, async t => {
  const received: { method: string; session?: string; protocol?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    received.push({ method: rpc.method, session: request.headers["mcp-session-id"] as string, protocol: request.headers["mcp-protocol-version"] as string });
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (mode === "failure" || mode === "expired") { response.writeHead(mode === "failure" ? 503 : 404).end("upstream error"); return; }
    if (mode === "redirect") { response.writeHead(307, { Location: "/destination" }).end(); return; }
    if (!("id" in rpc)) { response.writeHead(202).end(); return; }
    const reply = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "BRIDGE-OK" }] } });
    response.writeHead(200, { "Content-Type": mode === "sse" ? "text/event-stream" : "application/json", "Mcp-Session-Id": request.headers["mcp-session-id"]! });
    response.end(mode === "sse" ? `event: message\ndata: ${reply}\n\n` : reply);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [new URL("../boot/mcp-bridge.ts", import.meta.url).pathname], {
    env: { PLOW_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, PLOW_AGENT_TOKEN: "fixture-token" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(async () => { const closed = once(child, "close"); child.kill(); await closed; });
  await once(child, "message");
  const responses = await Promise.all(["session-A", "session-B"].map(session => fetch("http://127.0.0.1:18790/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: session, method: "tools/call", params: { name: "write_file" } }),
  })));
  assert.equal(received.length, 2);
  assert.deepEqual(received.map(r => r.session).sort(), ["session-A", "session-B"]);
  assert.ok(received.every(r => r.protocol === "2025-06-18"));
  for (const [i, response] of responses.entries()) {
    assert.equal(response.status, mode === "failure" ? 503 : mode === "expired" ? 404 : mode === "redirect" ? 502 : 200);
    if (mode === "json" || mode === "sse") {
      assert.equal(response.headers.get("mcp-session-id"), i ? "session-B" : "session-A");
      assert.ok((await response.text()).includes("BRIDGE-OK"));
    } else await response.text();
  }
  if (mode === "json" || mode === "sse") {
    const response = await fetch("http://127.0.0.1:18790/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
});
