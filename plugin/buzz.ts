// The Buzz channel: this agent in a Buzz community, opted in by the image (BUZZ_ATTESTATION_PROVIDER). It
// keeps the agent's own key, enrolls with the attestation provider (the owner approves a link texted on the
// Plow line), attests daily, names itself, and runs Block's buzz-acp against this gateway so that mentions
// and DMs in Buzz become turns the agent answers with the buzz CLI. A hire (an agent the control plane
// provisioned) is approved at enrollment and takes its profile, respond-to list and instructions from its
// attestation instead of the image's config.
import { writeFile, chmod, mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { RelayHttp, ensureProfile, npubOf } from "./buzz-kit.mjs";
import { joinHomeroom, loadOrCreateKey, type Hire } from "./buzz-identity.ts";
import { acpEnv, superviseAcp, type Supervisor } from "./buzz-acp.ts";

export type BuzzAccount = {
  accountId: string;
  /** The attestation provider's base URL (the qyvr agent API: /v1/info, /v1/enroll, /v1/attest). */
  provider: string;
  /** Hex pubkeys whose messages start turns besides the attesting owner. */
  respondTo: string[];
  name: string;
  handle: string;
  about: string;
  avatar?: string;
  harness: string;
  model: string;
};

type Deps = {
  notifyOwner: (cfg: OpenClawConfig, text: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  stateDir?: () => string;
  supervise?: typeof superviseAcp;
  /** Base delay between failed attempts. */
  retryMs?: number;
  reattestSeconds?: number;
};

/** Attest well before the 24-hour tag runs out. */
const REATTEST_SECONDS = 20 * 60 * 60;
const ENROLLING_RECHECK_SECONDS = 30;
const GATEWAY_PORT = 18789;

const HIRE_OPEN = "<!-- qyvr-hire -->";
const HIRE_CLOSE = "<!-- /qyvr-hire -->";

/** `prompt` with the hire's instructions as its one trailing qyvr-hire section, replacing any earlier one. */
export function withHireSection(prompt: string, instructions: string): string {
  let kept = prompt;
  const start = prompt.indexOf(HIRE_OPEN);
  if (start >= 0) {
    const end = prompt.indexOf(HIRE_CLOSE, start);
    kept = prompt.slice(0, start) + (end < 0 ? "" : prompt.slice(end + HIRE_CLOSE.length));
  }
  const body = instructions.split(HIRE_OPEN).join("").split(HIRE_CLOSE).join("").trim();
  const head = kept.trimEnd();
  return `${head ? `${head}\n\n` : ""}${HIRE_OPEN}\n${body}\n${HIRE_CLOSE}\n`;
}

async function writeHireInstructions(file: string, hire: Hire) {
  let prompt = "";
  try { prompt = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const next = withHireSection(prompt, hire.instructions);
  if (next === prompt) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, next);
  await rename(`${file}.tmp`, file);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done);
});

export function createBuzzChannel(deps: Deps): ChannelPlugin<BuzzAccount> {
  const now = () => Math.floor(Date.now() / 1000);
  const stateDir = deps.stateDir ?? (() => process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow");
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const supervise = deps.supervise ?? superviseAcp;
  const retryMs = deps.retryMs ?? 3000;
  const reattestSeconds = deps.reattestSeconds ?? REATTEST_SECONDS;

  async function relayUrlOf(provider: string): Promise<string> {
    const response = await fetch(`${provider.replace(/\/+$/, "")}/v1/info`);
    if (!response.ok) throw new Error(`attestation provider /v1/info: HTTP ${response.status}`);
    const info = await response.json() as { relay_url?: unknown };
    if (typeof info.relay_url !== "string" || !info.relay_url) throw new Error("attestation provider /v1/info has no relay_url");
    return info.relay_url;
  }

  return {
    id: "buzz",
    meta: { id: "buzz", label: "Buzz", selectionLabel: "Buzz", docsPath: "/channels/buzz", blurb: "A Buzz community, through buzz-acp" },
    capabilities: { chatTypes: ["group"], media: false },
    config: {
      listAccountIds: cfg => cfg.channels?.buzz ? ["default"] : [],
      resolveAccount: (cfg, accountId) => ({ ...(cfg.channels?.buzz as BuzzAccount), accountId: accountId ?? "default" }),
      isConfigured: account => Boolean(account.provider),
      formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
    },
    gateway: {
      startAccount: async ctx => {
        const account = ctx.account;
        const signal = ctx.abortSignal;
        const log = (text: string) => ctx.log?.info(text);
        const dir = `${stateDir()}/buzz`;
        const key = await loadOrCreateKey(dir);
        log(`buzz identity ${npubOf(key.pk)}`);
        let relayUrl: string | null = null;
        let supervisor: Supervisor | null = null;
        let failures = 0;
        while (!signal.aborted) {
          try {
            if (!relayUrl) {
              relayUrl = await relayUrlOf(account.provider);
              // The buzz and qyvr wrappers read it, so the image names no relay of its own.
              await writeFile(`${dir}/relay-url`, `${relayUrl}\n`, { mode: 0o600 });
            }
            const joined = await joinHomeroom({
              dir, qyvrHome: `${stateDir()}/qyvr`, key, controlUrl: account.provider, fetch, now,
              enroll: { name: account.handle, harness: account.harness, model: account.model },
              notifyOwner: text => deps.notifyOwner(ctx.cfg, text),
            });
            failures = 0;
            if (joined.status === "revoked") { log("buzz: revoked; not joining"); break; }
            if (joined.status === "approved") { log("buzz: enrollment approved; attesting"); continue; }
            if (joined.status === "enrolling") {
              log("buzz: waiting for the owner to approve enrollment");
              await sleep(ENROLLING_RECHECK_SECONDS * 1000, signal);
              continue;
            }
            const relay = new RelayHttp(relayUrl, key.sk, { authTag: joined.tag, fetch });
            const hire = joined.hire;
            if (hire) await writeHireInstructions(`${stateDir()}/workspace/AGENTS.md`, hire);
            const profile = hire?.profile ?? { display_name: account.name, name: account.handle, about: account.about, ...(account.avatar ? { picture: account.avatar } : {}) };
            await ensureProfile(relay, profile).catch(error => log(`buzz profile: ${(error as Error).message}`));
            const token = process.env.OPENCLAW_GATEWAY_TOKEN;
            if (!token) throw new Error("the gateway has no OPENCLAW_GATEWAY_TOKEN; buzz-acp cannot reach it");
            const tokenFile = `${dir}/gateway.token`;
            await writeFile(tokenFile, token, { mode: 0o600 });
            await chmod(tokenFile, 0o600);
            const env = acpEnv({ relayUrl, key, tag: joined.tag, gatewayPort: GATEWAY_PORT, tokenFile, respondTo: [...new Set([...(account.respondTo ?? []), ...(hire?.respond_to ?? [])].map(pk => pk.toLowerCase()))] });
            if (supervisor) supervisor.restart(env);
            else supervisor = supervise({ env, signal, log });
            log(`buzz: attested until ${joined.expiresAt}; buzz-acp running`);
            await sleep(Math.max(reattestSeconds * 1000, retryMs), signal);
          } catch (error) {
            failures++;
            log(`buzz: ${(error as Error).message}`);
            await sleep(Math.min(60_000, retryMs * 2 ** Math.min(failures, 10)), signal);
          }
        }
        if (supervisor) await supervisor.done;
      },
    },
  };
}
