import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { verifyNip98 } from "../plugin/buzz-kit.mjs";
import { joinHomeroom, loadOrCreateKey, readState } from "../plugin/buzz-identity.ts";

async function dirs(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(`${tmpdir()}/buzz-identity-`);
  t.after(() => rm(root, { recursive: true }));
  return { dir: `${root}/buzz`, qyvrHome: `${root}/qyvr` };
}

test("the key is created once, private, and reused", async t => {
  const { dir } = await dirs(t);
  const first = await loadOrCreateKey(dir);
  assert.match(first.sk, /^[0-9a-f]{64}$/);
  assert.equal((await stat(`${dir}/key`)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await loadOrCreateKey(dir), first);
});

/** A control plane answering /v1/attest and /v1/enroll from `answers`, recording NIP-98-verified calls. */
function controlPlane(answers: Record<string, () => Response>) {
  const calls: { path: string; pubkey: string; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = String(init.body ?? "");
    const { pubkey } = verifyNip98((init.headers as Record<string, string>).Authorization, { method: "POST", url, bodyText: body, now: Math.floor(Date.now() / 1000) });
    const path = new URL(url).pathname;
    calls.push({ path, pubkey, body: body ? JSON.parse(body) : null });
    return answers[path]!();
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}
const refuse = (error: string) => () => Response.json({ error, message: error }, { status: 403 });
const tag = ["auth", "a".repeat(64), "created_at<2000000000", "b".repeat(128)];

async function setup(t: Parameters<typeof dirs>[0], answers: Record<string, () => Response>) {
  const d = await dirs(t);
  const key = await loadOrCreateKey(d.dir);
  const cp = controlPlane(answers);
  const texts: string[] = [];
  let now = 1_000_000;
  const join = (force = false) => joinHomeroom({
    ...d, key, controlUrl: "https://control.test", fetch: cp.fetch, now: () => now, force,
    enroll: { name: "nick-fury", harness: "openclaw", model: "glm-5.2" },
    notifyOwner: async text => { texts.push(text); },
  });
  return { ...d, key, cp, texts, join, advance: (s: number) => { now += s; } };
}

test("an active agent attests and the tag is cached where the qyvr CLI reads it", async t => {
  const s = await setup(t, { "/v1/attest": () => Response.json({ tag, expires_at: 2_000_000_000 }) });
  const r = await s.join();
  assert.deepEqual(r, { status: "attested", tag, expiresAt: 2_000_000_000 });
  const file = `${s.qyvrHome}/${s.key.pk}/auth-tag`;
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), tag);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(s.cp.calls[0]!.pubkey, s.key.pk);
  assert.deepEqual(s.texts, []);
});

test("an unknown agent enrolls and texts the owner the link, once", async t => {
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => Response.json({ url: "https://buzz.qyvr.ai/enroll/abc", expires_at: 1 }),
  });
  assert.deepEqual(await s.join(), { status: "enrolling" });
  assert.deepEqual(s.cp.calls[1]!.body, { name: "nick-fury", harness: "openclaw", model: "glm-5.2" });
  assert.deepEqual(s.texts, ["Approve me into the qyvr homeroom: https://buzz.qyvr.ai/enroll/abc"]);
  s.advance(3600);
  assert.deepEqual(await s.join(), { status: "enrolling" });
  assert.equal(s.texts.length, 1, "no second link within a day");
  assert.equal((await readState(s.dir)).enrollSentAt, 1_000_000);
});

test("a new link goes out after a day, or after the old one expired when the owner asks", async t => {
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => Response.json({ url: "https://buzz.qyvr.ai/enroll/abc", expires_at: 1 }),
  });
  await s.join();
  s.advance(600);
  await s.join(true);
  assert.equal(s.texts.length, 1, "the first link has not expired yet");
  s.advance(600);
  await s.join(true);
  assert.equal(s.texts.length, 2);
  s.advance(86_400);
  await s.join();
  assert.equal(s.texts.length, 3);
});

test("a revoked agent says so once and stops", async t => {
  const s = await setup(t, { "/v1/attest": refuse("revoked") });
  assert.deepEqual(await s.join(), { status: "revoked" });
  assert.deepEqual(await s.join(), { status: "revoked" });
  assert.deepEqual(s.texts, ["I was revoked from the qyvr homeroom, so I have left it."]);
});

test("any other refusal is an error, not a state change", async t => {
  const s = await setup(t, { "/v1/attest": () => new Response("upstream down", { status: 502 }) });
  await assert.rejects(s.join(), /502/);
  assert.deepEqual(s.texts, []);
});
