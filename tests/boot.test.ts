import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("boot polls identity without a plugin installation", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-boot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boot = new URL("../boot/", import.meta.url);
  for (const name of await readdir(boot)) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile(new URL(name, boot), "utf8");
    await writeFile(join(root, name.replace(/\.ts$/, ".js")), stripTypeScriptTypes(source.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
  }
  let polls = 0;
  const pollTimes: number[] = [];
  const server = createServer((request, response) => {
    pollTimes.push(performance.now());
    assert.equal(request.url, "/v1/agents/me");
    assert.equal(request.headers.authorization, "Bearer boot-fixture");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ line: { uid: "line" }, chats: [] }));
    if (++polls === 2) server.emit("polled");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const polled = once(server, "polled");
  const child = spawn(process.execPath, [join(root, "main.js")], {
    env: { PLOW_API_BASE: `http://127.0.0.1:${address.port}`, PLOW_AGENT_TOKEN: "boot-fixture" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => { child.kill(); await closed; });
  await Promise.race([polled, closed.then(() => assert.fail(stderr))]);
  assert.equal(polls, 2);
  assert.ok(pollTimes[1] - pollTimes[0] >= 5_000, "identity polls must be at least five seconds apart");
});
