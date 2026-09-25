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

/** `failTexts` is how many texts fail first, as when the owner has no chat yet. */
async function setup(t: Parameters<typeof dirs>[0], answers: Record<string, () => Response>, failTexts = 0) {
  const d = await dirs(t);
  const key = await loadOrCreateKey(d.dir);
  const cp = controlPlane(answers);
  const texts: string[] = [];
  let now = 1_000_000;
  const join = (force = false) => joinHomeroom({
    ...d, key, controlUrl: "https://control.test", fetch: cp.fetch, now: () => now, force,
    enroll: { name: "nick-fury", harness: "openclaw", model: "glm-5.2" },
    notifyOwner: async text => {
      if (failTexts > 0) { failTexts--; throw new Error("no chat with the owner yet"); }
      texts.push(text);
    },
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

test("when the text fails, only the text is retried while the link is unexpired", async t => {
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => Response.json({ url: "https://buzz.qyvr.ai/enroll/abc", expires_at: 1_000_000 + 900 }),
  }, 2);
  await assert.rejects(s.join(), /no chat/);
  s.advance(60);
  await assert.rejects(s.join(), /no chat/);
  s.advance(60);
  assert.deepEqual(await s.join(), { status: "enrolling" });
  assert.equal(s.cp.calls.filter(c => c.path === "/v1/enroll").length, 1);
  assert.deepEqual(s.texts, ["Approve me into the qyvr homeroom: https://buzz.qyvr.ai/enroll/abc"]);
  assert.equal((await readState(s.dir)).enrollSentAt, 1_000_120);
  s.advance(60);
  await s.join();
  assert.equal(s.texts.length, 1, "a delivered link is not sent again");
});

test("a link that expired before it could be texted is replaced by a new enrollment", async t => {
  let n = 0;
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => { n++; return Response.json({ url: `https://buzz.qyvr.ai/enroll/${n}`, expires_at: 1_000_000 + n * 900 }); },
  }, 1);
  await assert.rejects(s.join(), /no chat/);
  s.advance(900);
  await s.join();
  assert.equal(s.cp.calls.filter(c => c.path === "/v1/enroll").length, 2);
  assert.deepEqual(s.texts, ["Approve me into the qyvr homeroom: https://buzz.qyvr.ai/enroll/2"]);
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

test("state updates are atomic and serialized, so concurrent writers lose nothing", async t => {
  const { dir } = await dirs(t);
  await loadOrCreateKey(dir);
  const { updateState } = await import("../plugin/buzz-identity.ts");
  await Promise.all([updateState(dir, { enrollSentAt: 5 }), updateState(dir, { cursor: { since: 7, ids: ["a"] } }), updateState(dir, { revokedNotified: true })]);
  assert.deepEqual(await readState(dir), { enrollSentAt: 5, cursor: { since: 7, ids: ["a"] }, revokedNotified: true });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(dir)).sort(), ["key", "state.json"], "no temp files left behind");
});
