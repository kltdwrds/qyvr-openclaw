import { setTimeout as sleep } from "node:timers/promises";
import { findOwnerChat, type Identity } from "./config.ts";

export async function identityFromApi(base: string, token: string, initial = true): Promise<Identity | undefined> {
  const authDeadline = Date.now() + 120_000;
  const attempts = initial ? 10 : 3;
  const backoff = initial ? 3_000 : 1_000;
  let failures = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${base}/v1/agents/me`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (++failures === attempts) {
        if (!initial) return;
        throw new Error("Identity request failed after 10 attempts");
      }
      await sleep(backoff);
      continue;
    }
    if (response.ok) {
      const identity = await response.json() as Identity;
      findOwnerChat(identity);
      return identity;
    }
    if (initial && [401, 403].includes(response.status) && Date.now() < authDeadline) {
      console.log(`plow-boot: identity HTTP ${response.status}; waiting for credential propagation`);
      await sleep(Math.min(3_000, authDeadline - Date.now()));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (++failures < attempts) { await sleep(backoff); continue; }
      if (!initial) return;
    }
    throw new Error(`Identity request refused: HTTP ${response.status}`);
  }
}
