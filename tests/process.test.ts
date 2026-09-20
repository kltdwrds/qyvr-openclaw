import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { startGateway } from "../boot/process.ts";

for (const ending of ["gateway", "bridge", "signal", "startup-failure"] as const) test(`supervisor closes both children: ${ending}`, async t => {
  const previousCode = process.exitCode;
  const listeners = process.listenerCount("SIGTERM");
  const children: (EventEmitter & { kill: (signal: string) => void; signals: string[] })[] = [];
  const options: SpawnOptions[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], opts: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child); options.push(opts);
    if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => ending === "startup-failure" ? child.emit("close", 1, null) : child.emit("message", "ready"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); process.exitCode = previousCode; });
  const starting = startGateway(true, "https://relay/mcp");
  assert.equal(children.length, 1, "gateway waits for bridge readiness");
  if (ending === "startup-failure") {
    await assert.rejects(starting, /closed before readiness/);
    assert.equal(children.length, 1);
  } else {
    assert.equal(await starting, children[1]);
    assert.deepEqual(Object.keys(options[0].env!).sort(), ["PLOW_AGENT_TOKEN", "PLOW_MCP_URL"]);
    if (ending === "signal") process.emit("SIGTERM");
    else children[ending === "gateway" ? 1 : 0].emit("close", ending === "gateway" ? 0 : 1, null);
    await setImmediate();
    assert.ok(children[ending === "gateway" ? 0 : 1].signals.includes("SIGTERM"));
  }
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(process.exitCode, ending === "bridge" || ending === "startup-failure" ? 1 : previousCode);
});
