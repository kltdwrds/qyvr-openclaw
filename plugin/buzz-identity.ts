// Nick's place in the qyvr homeroom: its own Nostr key (created once, kept in the state volume), enrollment
// with the qyvr control plane, and the daily NIP-OA attestation that admits it to the relay. The key never
// goes into env, argv or logs.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { generateKeypair, pubkeyOf, signNip98 } from "./buzz-kit.mjs";

export type Key = { sk: string; pk: string };
export type AuthTag = [string, string, string, string];
export type State = {
  /** When the last enrollment link was texted to the owner (unix seconds). */
  enrollSentAt?: number;
  /** An enrollment link not yet texted to the owner, kept so a failed text is retried without enrolling again. */
  enrollLink?: { url: string; expiresAt: number };
  revokedNotified?: boolean;
  /** Newest mention handled: its created_at and the ids handled at that second. */
  cursor?: { since: number; ids: string[] };
};
export type Joined = { status: "attested"; tag: AuthTag; expiresAt: number } | { status: "enrolling" } | { status: "revoked" };

/** An enrollment link lasts 15 minutes on the control plane; an unanswered one is resent after a day. */
export const ENROLL_LINK_SECONDS = 15 * 60;
export const ENROLL_RESEND_SECONDS = 24 * 60 * 60;

export async function loadOrCreateKey(dir: string): Promise<Key> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  try {
    const sk = (await readFile(`${dir}/key`, "utf8")).trim();
    return { sk, pk: pubkeyOf(sk) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { sk, pk } = generateKeypair();
  await writeFile(`${dir}/key`, `${sk}\n`, { mode: 0o600, flag: "wx" });
  return { sk, pk };
}

export async function readState(dir: string): Promise<State> {
  try { return JSON.parse(await readFile(`${dir}/state.json`, "utf8")) as State; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

let stateQueue: Promise<unknown> = Promise.resolve();

/**
 * Merges `change` into state.json. Updates run one at a time (the poll loop and the qyvr_enroll tool both
 * write), and each replaces the file by rename, so a crash never leaves it half written.
 */
export function updateState(dir: string, change: Partial<State>): Promise<State> {
  const run = stateQueue.then(async () => {
    const next = { ...(await readState(dir)), ...change };
    await writeFile(`${dir}/state.json.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${dir}/state.json.tmp`, `${dir}/state.json`);
    return next;
  });
  stateQueue = run.catch(() => {});
  return run;
}

class ControlError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) { super(message); this.status = status; this.code = code; }
}

async function call<T>(fetch: typeof globalThis.fetch, controlUrl: string, key: Key, path: string, body: unknown): Promise<T> {
  const url = `${controlUrl.replace(/\/+$/, "")}${path}`;
  const text = JSON.stringify(body);
  const response = await fetch(url, { method: "POST", headers: { Authorization: signNip98(key.sk, "POST", url, text), "Content-Type": "application/json" }, body: text });
  const raw = await response.text();
  let json: { error?: string; message?: string } | null = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  if (!response.ok) throw new ControlError(response.status, json?.error, `control plane ${path}: HTTP ${response.status} ${json?.error ?? raw.slice(0, 200)}`);
  return json as T;
}

export type JoinOptions = {
  dir: string;
  qyvrHome: string;
  key: Key;
  controlUrl: string;
  enroll: { name: string; harness: string; model: string };
  notifyOwner: (text: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** The owner asked for a fresh link: send one as soon as the last has expired. */
  force?: boolean;
};

/**
 * Attests when the control plane knows this key; otherwise enrolls and texts the owner the approval link,
 * at most once per ENROLL_RESEND_SECONDS unless `force`. If the text fails (the owner has no chat yet), the
 * unexpired link is kept and only the text is retried. A revoked key tells the owner once.
 */
export async function joinHomeroom(o: JoinOptions): Promise<Joined> {
  const fetch = o.fetch ?? globalThis.fetch;
  const now = o.now?.() ?? Math.floor(Date.now() / 1000);
  try {
    const r = await call<{ tag: AuthTag; expires_at: number }>(fetch, o.controlUrl, o.key, "/v1/attest", {});
    const dir = `${o.qyvrHome}/${o.key.pk}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(`${dir}/auth-tag`, JSON.stringify(r.tag), { mode: 0o600 });
    await chmod(`${dir}/auth-tag`, 0o600);
    return { status: "attested", tag: r.tag, expiresAt: r.expires_at };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    const state = await readState(o.dir);
    if (error.code === "revoked") {
      if (!state.revokedNotified) {
        await o.notifyOwner("I was revoked from the qyvr homeroom, so I have left it.");
        await updateState(o.dir, { revokedNotified: true });
      }
      return { status: "revoked" };
    }
    if (error.code !== "unknown_agent") throw error;
    let link = state.enrollLink && now < state.enrollLink.expiresAt ? state.enrollLink : undefined;
    const since = state.enrollSentAt === undefined ? Infinity : now - state.enrollSentAt;
    if (!link && (since >= ENROLL_RESEND_SECONDS || (o.force && since >= ENROLL_LINK_SECONDS))) {
      const r = await call<{ url: string; expires_at: number }>(fetch, o.controlUrl, o.key, "/v1/enroll", o.enroll);
      link = { url: r.url, expiresAt: r.expires_at };
      await updateState(o.dir, { enrollLink: link });
    }
    if (link) {
      await o.notifyOwner(`Approve me into the qyvr homeroom: ${link.url}`);
      await updateState(o.dir, { enrollSentAt: now, enrollLink: undefined });
    }
    return { status: "enrolling" };
  }
}
