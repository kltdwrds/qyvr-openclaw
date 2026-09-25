// buzz-acp, Block's harness between a Buzz relay and an ACP agent, run as a child of the gateway: it hears
// mentions and DMs on the relay and drives `openclaw acp` against this gateway, and the agent answers
// through the buzz CLI. The key and attestation reach only the child's environment, never argv or logs.
import { spawn, type ChildProcess } from "node:child_process";
import type { AuthTag, Key } from "./buzz-identity.ts";

export type AcpSettings = {
  /** The relay's URL (http, https, ws or wss); buzz-acp dials its WebSocket form. */
  relayUrl: string;
  key: Key;
  tag: AuthTag;
  gatewayPort: number;
  /** File holding the gateway token, for `openclaw acp --token-file`. */
  tokenFile: string;
  /** Hex pubkeys whose messages start turns besides the attesting owner; empty means the owner only. */
  respondTo: string[];
};

/** The child's environment: identity, relay, the ACP agent command and the author gate. */
export function acpEnv(s: AcpSettings): Record<string, string> {
  const relay = s.relayUrl.replace(/^http(s?):/, "ws$1:").replace(/\/+$/, "");
  const allow = s.respondTo.map(pk => pk.toLowerCase());
  return {
    BUZZ_PRIVATE_KEY: s.key.sk,
    BUZZ_AUTH_TAG: JSON.stringify(s.tag),
    BUZZ_RELAY_URL: relay,
    BUZZ_ACP_AGENT_COMMAND: "node",
    BUZZ_ACP_AGENT_ARGS: ["/app/openclaw.mjs", "acp", "--url", `ws://127.0.0.1:${s.gatewayPort}`, "--token-file", s.tokenFile].join(","),
    ...(allow.length ? { BUZZ_ACP_RESPOND_TO: "allowlist", BUZZ_ACP_RESPOND_TO_ALLOWLIST: allow.join(",") } : { BUZZ_ACP_RESPOND_TO: "owner-only" }),
  };
}

export type Supervisor = {
  /** Replaces the running child with one using `env` (a fresh attestation). */
  restart: (env: Record<string, string>) => void;
  /** Settles once the signal has aborted and the child is gone. */
  done: Promise<void>;
};

/**
 * Keeps one buzz-acp child running until `signal` aborts: a child that exits is started again after a
 * backoff that doubles up to a minute and resets once a child has run for a minute.
 */
export function superviseAcp(o: {
  env: Record<string, string>;
  signal: AbortSignal;
  log: (line: string) => void;
  command?: string;
  args?: string[];
  backoffMs?: number;
}): Supervisor {
  const command = o.command ?? "/opt/plow/libexec/buzz-acp";
  const base = o.backoffMs ?? 1000;
  let env = o.env;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;
  let delay = base;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });

  const lines = (prefix: string) => (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) o.log(`${prefix}${line}`);
  };

  function start() {
    if (o.signal.aborted) return;
    const started = Date.now();
    const c = spawn(command, o.args ?? [], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    c.stdout!.on("data", lines("buzz-acp: "));
    c.stderr!.on("data", lines("buzz-acp: "));
    c.on("error", error => o.log(`buzz-acp: failed to start: ${error.message}`));
    c.on("close", (code, signal) => {
      if (child === c) child = null;
      if (o.signal.aborted) { if (!child) resolveDone(); return; }
      if ((c as ChildProcess & { replaced?: boolean }).replaced) return;
      o.log(`buzz-acp: exited code=${code} signal=${signal}; restarting in ${delay}ms`);
      if (Date.now() - started > 60_000) delay = base;
      timer = setTimeout(start, delay);
      delay = Math.min(60_000, delay * 2);
    });
  }

  o.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    if (child) child.kill("SIGTERM");
    else resolveDone();
  }, { once: true });

  start();
  return {
    restart(next) {
      env = next;
      if (o.signal.aborted) return;
      clearTimeout(timer);
      delay = base;
      if (child) {
        (child as ChildProcess & { replaced?: boolean }).replaced = true;
        child.kill("SIGTERM");
        child = null;
      }
      start();
    },
    done,
  };
}
