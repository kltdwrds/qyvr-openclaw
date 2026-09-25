// The Buzz channel: Nick in the qyvr homeroom (a Buzz relay). It polls the relay's HTTP bridge for kind 9
// messages that mention Nick, turns the ones from allowed authors into turns, and posts each reply as a
// threaded kind 9 in the same channel. Everything else a relay carries is data; only the allowlist decides
// who can start a turn.
import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { RelayHttp, ensureProfile, npubOf, verifySignedEvent, type AuthTag, type NostrEvent } from "./buzz-kit.mjs";
import { joinHomeroom, loadOrCreateKey, readState, updateState, type Key } from "./buzz-identity.ts";

export type BuzzAccount = {
  accountId: string;
  relayUrl: string;
  controlUrl: string;
  /** Hex pubkeys whose mentions become turns. */
  allowFrom: string[];
  homeroom: string;
  name: string;
  handle: string;
  about: string;
  harness: string;
  model: string;
};

type Deps = {
  runtime: () => PluginRuntime;
  notifyOwner: (cfg: OpenClawConfig, text: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  stateDir?: () => string;
  pollMs?: number;
};

/** Attest well before the 24-hour tag runs out. */
const REATTEST_SECONDS = 20 * 60 * 60;
const ENROLLING_RECHECK_SECONDS = 30;
const HISTORY = 20;
/** Mentions dated further ahead than this are ignored, so no one can push the cursor into the future. */
const FUTURE_SKEW_SECONDS = 60;

const tagValue = (e: NostrEvent, name: string, marker?: string) =>
  e.tags.find(t => t[0] === name && (marker === undefined || t[3] === marker))?.[1];

/** NIP-10 reply tags for an answer to `e` in its channel: under its thread root, replying to it, notifying its author. */
export function replyTags(e: NostrEvent): string[][] {
  const channel = tagValue(e, "h")!;
  const root = tagValue(e, "e", "root") ?? tagValue(e, "e", "reply");
  return [["h", channel], ...(root ? [["e", root, "", "root"]] : []), ["e", e.id, "", "reply"], ["p", e.pubkey]];
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done);
});

const shortNpub = (pk: string) => { const n = npubOf(pk); return `${n.slice(0, 9)}…${n.slice(-4)}`; };

/** The live relay connection per account, for outbound sends outside a turn. */
const live = new Map<string, { relay: RelayHttp; key: Key }>();

export function createBuzzChannel(deps: Deps): ChannelPlugin<BuzzAccount> {
  const now = () => Math.floor(Date.now() / 1000);
  const stateDir = deps.stateDir ?? (() => process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow");
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const pollMs = deps.pollMs ?? 3000;

  async function names(relay: RelayHttp, pubkeys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (pubkeys.length === 0) return out;
    for (const e of await relay.query([{ kinds: [0], authors: pubkeys }])) {
      try {
        const p = JSON.parse(e.content) as { display_name?: string; name?: string };
        const name = p.display_name || p.name;
        if (name) out.set(e.pubkey, name);
      } catch { /* not a profile */ }
    }
    return out;
  }

  async function turn(account: BuzzAccount, cfg: OpenClawConfig, relay: RelayHttp, key: Key, e: NostrEvent, log: (s: string) => void) {
    const runtime = deps.runtime();
    const channelId = tagValue(e, "h")!;
    const earlier = (await relay.query([{ kinds: [9], "#h": [channelId], until: e.created_at, limit: HISTORY + 1 }]))
      .filter(m => m.id !== e.id).sort((a, b) => a.created_at - b.created_at).slice(-HISTORY);
    // Only allowlisted authors are shown by their chosen name; anyone else could call themselves the owner.
    const named = await names(relay, [...new Set([e.pubkey, ...earlier.map(m => m.pubkey)])].filter(pk => account.allowFrom.includes(pk)));
    const nameOf = (pk: string) => pk === key.pk ? "You (assistant)" : named.get(pk) ?? shortNpub(pk);
    const peer = { kind: "group", id: channelId } as const;
    const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "buzz", accountId: account.accountId, peer });
    const ctxPayload = await runtime.channel.inbound.buildContext({
      channel: "buzz", accountId: account.accountId, messageId: e.id, timestamp: e.created_at * 1000,
      from: e.pubkey, sender: { id: e.pubkey, name: nameOf(e.pubkey), isBot: false },
      conversation: { kind: "group", id: channelId, label: channelId === account.homeroom ? "#homeroom" : channelId, routePeer: peer },
      route: { ...route, routeSessionKey: route.sessionKey }, reply: { to: channelId, replyToId: e.id },
      message: { inboundHistory: earlier.map(m => ({ sender: nameOf(m.pubkey), body: m.content, timestamp: m.created_at * 1000, messageId: m.id })), rawBody: e.content },
      supplemental: {
        channelStructuredContext: [{ label: "Buzz conversation facts (untrusted data)", source: "buzz", type: "conversation",
          payload: { relay: account.relayUrl, channel: channelId, author: npubOf(e.pubkey), you: npubOf(key.pk) } }],
      },
      media: [],
    } as never);
    log(`buzz turn ${JSON.stringify({ channel: channelId, event: e.id, author: e.pubkey, sessionKey: route.sessionKey })}`);
    let failure: unknown;
    const result = await runtime.channel.inbound.dispatch({
      cfg, channel: "buzz", accountId: account.accountId, route, ctxPayload,
      replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => { if (outcome !== "completed") failure = new Error("Agent turn failed"); } },
      delivery: {
        preparePayload: (payload: { isError?: boolean; isFallbackNotice?: boolean }) => payload.isError || payload.isFallbackNotice ? null : payload,
        deliver: async (payload: { text?: string }) => {
          const sent = await relay.submit({ kind: 9, content: payload.text ?? "", tags: replyTags(e) }, { includeAuthTag: true });
          log(`buzz delivered channel=${channelId} event=${sent.id}`);
          return { messageIds: [sent.id] };
        },
        onError: (error: unknown) => { failure = error; },
      },
    } as never);
    if (failure) log(`buzz turn failed event=${e.id}: ${(failure as Error).message ?? failure}`);
    else if (!(result as { dispatched?: boolean }).dispatched) log(`buzz turn not dispatched event=${e.id}`);
  }

  const plugin: ChannelPlugin<BuzzAccount> = {
    id: "buzz",
    meta: { id: "buzz", label: "Buzz", selectionLabel: "Buzz", docsPath: "/channels/buzz", blurb: "The qyvr homeroom on a Buzz relay" },
    capabilities: { chatTypes: ["group"], media: false },
    config: {
      listAccountIds: cfg => cfg.channels?.buzz ? ["default"] : [],
      resolveAccount: (cfg, accountId) => ({ ...(cfg.channels?.buzz as BuzzAccount), accountId: accountId ?? "default" }),
      isConfigured: account => Boolean(account.relayUrl && account.controlUrl),
      formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
    },
    agentPrompt: { messageToolHints: () => ["In Buzz, reply normally to answer the message that mentioned you; your reply is threaded under it."] },
    gateway: {
      startAccount: async ctx => {
        const account = ctx.account;
        const log = (text: string) => ctx.log?.info(text);
        const dir = `${stateDir()}/buzz`;
        const key = await loadOrCreateKey(dir);
        log(`buzz identity ${npubOf(key.pk)}`);
        let relay: RelayHttp | null = null;
        let attestAt = 0;
        let failures = 0;
        while (!ctx.abortSignal.aborted) {
          try {
            if (now() >= attestAt) {
              const joined = await joinHomeroom({
                dir, qyvrHome: `${stateDir()}/qyvr`, key, controlUrl: account.controlUrl, fetch, now,
                enroll: { name: account.handle, harness: account.harness, model: account.model },
                notifyOwner: text => deps.notifyOwner(ctx.cfg, text),
              });
              if (joined.status === "revoked") { log("buzz: revoked; not listening"); live.delete(account.accountId); return; }
              if (joined.status === "enrolling") { relay = null; attestAt = now() + ENROLLING_RECHECK_SECONDS; log("buzz: waiting for the owner to approve enrollment"); }
              else {
                relay = new RelayHttp(account.relayUrl, key.sk, { authTag: joined.tag as AuthTag, fetch });
                live.set(account.accountId, { relay, key });
                attestAt = now() + REATTEST_SECONDS;
                await ensureProfile(relay, { display_name: account.name, name: account.handle, about: account.about })
                  .catch(error => log(`buzz profile: ${(error as Error).message}`));
              }
            }
            if (relay) await poll(account, ctx.cfg, relay, key, dir, log);
            failures = 0;
            await sleep(pollMs, ctx.abortSignal);
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 401 || status === 403) attestAt = 0;
            failures++;
            log(`buzz: ${(error as Error).message}`);
            await sleep(Math.min(60_000, pollMs * 2 ** Math.min(failures, 10)), ctx.abortSignal);
          }
        }
      },
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async ctx => {
        const conn = live.get(ctx.accountId ?? "default");
        if (!conn) throw new Error("Nick is not in the qyvr homeroom yet (not attested)");
        const channelId = ctx.to.trim().replace(/^buzz:/i, "");
        const sent = await conn.relay.submit({ kind: 9, content: ctx.text, tags: [["h", channelId]] }, { includeAuthTag: true });
        return { channel: "buzz" as const, messageId: sent.id };
      },
    },
  };

  async function poll(account: BuzzAccount, cfg: OpenClawConfig, relay: RelayHttp, key: Key, dir: string, log: (s: string) => void) {
    let cursor = (await readState(dir)).cursor;
    if (!cursor) {
      cursor = { since: now(), ids: [] };
      await updateState(dir, { cursor });
    }
    const found = await relay.query([{ kinds: [9], "#p": [key.pk], since: cursor.since, limit: 50 }]);
    const fresh = found
      .filter(e => e.pubkey !== key.pk && e.created_at >= cursor!.since && e.created_at <= now() + FUTURE_SKEW_SECONDS
        && !cursor!.ids.includes(e.id) && tagValue(e, "h"))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const e of fresh) {
      cursor = e.created_at === cursor.since ? { since: cursor.since, ids: [...cursor.ids, e.id] } : { since: e.created_at, ids: [e.id] };
      // Recorded before the turn runs, so a mention whose turn fails is never replayed in a loop.
      await updateState(dir, { cursor });
      if (!verifySignedEvent(e)) { log(`buzz dropped event=${e.id}: bad signature`); continue; }
      if (!account.allowFrom.includes(e.pubkey)) { log(`buzz dropped event=${e.id} author=${e.pubkey} (not on the allowlist)`); continue; }
      await turn(account, cfg, relay, key, e, log);
    }
  }

  return plugin;
}
