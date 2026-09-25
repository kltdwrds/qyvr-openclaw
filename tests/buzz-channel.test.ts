import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { verifyNip98, type NostrEvent } from "../plugin/buzz-kit.mjs";
import { createBuzzChannel } from "../plugin/buzz.ts";
import { loadOrCreateKey } from "../plugin/buzz-identity.ts";

const KYLE = "c2b88f74b2f2fed397726b430eb8020e514cfc6c7234bec9fa6d93f4f2769808";
const now = () => Math.floor(Date.now() / 1000);
const tagFor = (n: number) => ["auth", "a".repeat(64), `created_at<${2_000_000_000 + n}`, "b".repeat(128)];

/** An attestation provider (https://provider.test) and the relay it names (https://relay.test). */
function world(attest: () => Response) {
  const events: NostrEvent[] = [];
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/v1/info") return Response.json({ relay_url: "https://relay.test", homeroom: "room" });
    const body = String(init?.body ?? "");
    verifyNip98((init!.headers as Record<string, string>).Authorization, { method: "POST", url, bodyText: body, now: now() });
    if (url.startsWith("https://provider.test")) return path === "/v1/attest" ? attest() : Response.json({ url: "https://provider.test/enroll/x", expires_at: now() + 900 });
    if (path === "/query") return Response.json(events.filter(e => e.kind === 0 && JSON.parse(body).some((f: { authors?: string[] }) => f.authors?.includes(e.pubkey))));
    events.push(JSON.parse(body));
    return Response.json({ accepted: true, event_id: "x", message: "" });
  };
  return { events, calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const cfg = { channels: { buzz: {
  provider: "https://provider.test", respondTo: [KYLE], name: "Nick Fury", handle: "nick-fury",
  about: "Send me an initiative and I'll assemble you a team", avatar: "https://example.test/nick.png", harness: "openclaw", model: "glm-5.2",
} } };

async function run(t: { after: (fn: () => Promise<void>) => void }, w: ReturnType<typeof world>, opts: { until: (starts: Record<string, string>[], texts: string[]) => boolean; reattestSeconds?: number }) {
  const root = await mkdtemp(`${tmpdir()}/buzz-channel-`);
  t.after(() => rm(root, { recursive: true }));
  const starts: Record<string, string>[] = [];
  const texts: string[] = [];
  const logs: string[] = [];
  let stopped = false;
  process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-for-tests";
  const channel = createBuzzChannel({
    notifyOwner: async (_cfg, text) => { texts.push(text); },
    fetch: w.fetch, stateDir: () => root, retryMs: 5, reattestSeconds: opts.reattestSeconds,
    supervise: ({ env, signal }) => {
      starts.push(env);
      const done = new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
      return { restart: env => { starts.push(env); }, done };
    },
  });
  const controller = new AbortController();
  const timer = setInterval(() => { if (opts.until(starts, texts)) controller.abort(); }, 5);
  const deadline = setTimeout(() => controller.abort(), 4000);
  await channel.gateway!.startAccount!({ account: channel.config.resolveAccount(cfg as never, "default"), cfg, abortSignal: controller.signal, log: { info: (s: string) => logs.push(s) } } as never);
  clearInterval(timer); clearTimeout(deadline);
  return { root, starts, texts, logs, stopped: () => stopped };
}

test("an attested agent names itself, then runs buzz-acp against the provider's relay with the owner's allowlist", async t => {
  const w = world(() => Response.json({ tag: tagFor(1), expires_at: now() + 86400 }));
  const r = await run(t, w, { until: starts => starts.length > 0 });
  const key = await loadOrCreateKey(`${r.root}/buzz`);
  assert.equal(r.starts.length, 1);
  const env = r.starts[0]!;
  assert.equal(env.BUZZ_RELAY_URL, "wss://relay.test");
  assert.equal(env.BUZZ_PRIVATE_KEY, key.sk);
  assert.equal(env.BUZZ_AUTH_TAG, JSON.stringify(tagFor(1)));
  assert.equal(env.BUZZ_ACP_RESPOND_TO_ALLOWLIST, KYLE);
  assert.match(env.BUZZ_ACP_AGENT_ARGS!, new RegExp(`--token-file,${r.root}/buzz/gateway.token$`));
  assert.equal(await readFile(`${r.root}/buzz/gateway.token`, "utf8"), "gateway-token-for-tests");
  assert.equal((await stat(`${r.root}/buzz/gateway.token`)).mode & 0o777, 0o600);
  assert.equal((await readFile(`${r.root}/buzz/relay-url`, "utf8")).trim(), "https://relay.test");
  const profile = w.events.find(e => e.kind === 0)!;
  assert.equal(profile.pubkey, key.pk);
  assert.deepEqual(JSON.parse(profile.content), { display_name: "Nick Fury", name: "nick-fury", about: "Send me an initiative and I'll assemble you a team", picture: "https://example.test/nick.png" });
  assert.ok(r.stopped(), "buzz-acp stops with the gateway");
  assert.ok(!r.logs.some(l => l.includes(key.sk)), "the key never reaches the log");
});

test("each fresh attestation restarts buzz-acp with the new tag", async t => {
  let n = 0;
  const w = world(() => Response.json({ tag: tagFor(++n), expires_at: now() + 86400 }));
  const r = await run(t, w, { reattestSeconds: 0, until: starts => starts.length >= 2 });
  assert.equal(r.starts[0]!.BUZZ_AUTH_TAG, JSON.stringify(tagFor(1)));
  assert.equal(r.starts[1]!.BUZZ_AUTH_TAG, JSON.stringify(tagFor(2)));
});

test("an agent waiting for approval texts the owner and runs nothing", async t => {
  const w = world(() => Response.json({ error: "unknown_agent", message: "enroll first" }, { status: 403 }));
  const r = await run(t, w, { until: (_s, texts) => texts.length > 0 });
  assert.deepEqual(r.texts, ["Approve me into the qyvr homeroom: https://provider.test/enroll/x"]);
  assert.equal(r.starts.length, 0);
});

test("a revoked agent runs nothing and returns", async t => {
  const w = world(() => Response.json({ error: "revoked", message: "revoked" }, { status: 403 }));
  const r = await run(t, w, { until: () => false });
  assert.equal(r.starts.length, 0);
  assert.ok(r.logs.some(l => /revoked/.test(l)));
});
