import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { joinHomeroom, loadOrCreateKey } from "../plugin/buzz-identity.ts";

const bin = new URL("../bin/qyvr", import.meta.url).pathname;
const tag = ["auth", "a".repeat(64), "created_at<2000000000", "b".repeat(128)];

test("the qyvr wrapper runs the CLI as Nick with the cached attestation, without the key in argv", async t => {
  const root = await mkdtemp(`${tmpdir()}/qyvr-wrapper-`);
  t.after(() => rm(root, { recursive: true }));
  const key = await loadOrCreateKey(`${root}/buzz`);
  await joinHomeroom({ dir: `${root}/buzz`, qyvrHome: `${root}/qyvr`, key, controlUrl: "https://control.test",
    enroll: { name: "n", harness: "h", model: "m" }, notifyOwner: async () => {},
    fetch: (async () => Response.json({ tag, expires_at: 2_000_000_000 })) as unknown as typeof fetch });
  const r = spawnSync(bin, ["env"], { encoding: "utf8", env: { PATH: process.env.PATH, OPENCLAW_STATE_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `export BUZZ_AUTH_TAG='${JSON.stringify(tag)}'`);
  assert.ok(!r.stdout.includes(key.sk) && !r.stderr.includes(key.sk));
});

test("the wrappers refuse clearly before the channel has created a key", async t => {
  const root = await mkdtemp(`${tmpdir()}/qyvr-wrapper-`);
  t.after(() => rm(root, { recursive: true }));
  const r = spawnSync(bin, ["grants"], { encoding: "utf8", env: { PATH: process.env.PATH, OPENCLAW_STATE_DIR: root } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not_ready/);
});
