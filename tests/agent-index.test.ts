import assert from "node:assert/strict";
import { test } from "node:test";
import { startAgentIndex } from "../boot/agent-index.ts";

function recorder(codes: (number | null)[] = []) {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); return codes.shift() ?? 0; };
  return { calls, run };
}

test("an image without AGENT_ID reports nothing", async t => {
  delete process.env.AGENT_ID;
  const { calls, run } = recorder();
  assert.equal(await startAgentIndex(run), undefined);
  assert.deepEqual(calls, []);
});

test("an unregistered install registers once, then reports", async t => {
  process.env.AGENT_ID = "demo";
  t.after(() => { delete process.env.AGENT_ID; });
  const { calls, run } = recorder([3]);          // status: not registered
  const timer = await startAgentIndex(run);
  t.after(() => clearInterval(timer));
  assert.deepEqual(calls, [
    ["status"],
    ["--register", "--agent", "demo", "--runtime", "openclaw"],
    ["--agent", "demo"],
  ]);
});

for (const status of [0, 2, null]) test(`status ${status} never re-registers: a second key would split this install's usage`, async t => {
  process.env.AGENT_ID = "demo";
  t.after(() => { delete process.env.AGENT_ID; });
  const { calls, run } = recorder([status]);
  const timer = await startAgentIndex(run);
  t.after(() => clearInterval(timer));
  assert.deepEqual(calls, [["status"], ["--agent", "demo"]]);
});

test("a failed pass is swallowed, so the agent it reports on keeps running", async t => {
  process.env.AGENT_ID = "demo";
  t.after(() => { delete process.env.AGENT_ID; });
  const timer = await startAgentIndex(async () => { throw new Error("python3 missing"); });
  t.after(() => clearInterval(timer));
  assert.ok(timer, "boot continues");
});
