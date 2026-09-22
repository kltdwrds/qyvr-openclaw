import { findOwnerChat, type Identity } from "./config.ts";

export async function identityFromApi(base: string, token: string): Promise<Identity> {
  const response = await fetch(`${base}/v1/agents/me`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Identity request refused: HTTP ${response.status}`);
  const identity = await response.json() as Identity;
  findOwnerChat(identity);
  return identity;
}
