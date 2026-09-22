import { readFile } from "node:fs/promises";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";

export const PEER_SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
export const IDENTITY_HEADER = "x-plow-user-id";

export async function teamSettings() {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the teammate image`);
    return value;
  };
  const origin = required("PLOW_DASHBOARD_ORIGIN");
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("PLOW_DASHBOARD_ORIGIN must be an exact HTTP(S) origin");
  const port = Number(required("PLOW_ADAPTER_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 18789) throw new Error("PLOW_ADAPTER_PORT must be a valid port distinct from the gateway");
  const jwks = JSON.parse(await readFile(required("PLOW_ASSERTION_JWKS_FILE"), "utf8")) as JSONWebKeySet;
  if (!jwks.keys?.length || jwks.keys.some(key => key.kty !== "OKP" || key.crv !== "Ed25519" || key.d || !key.kid)) throw new Error("Assertion keys must be public Ed25519 JWKs with key IDs");
  return {
    origin, port, issuer: required("PLOW_ASSERTION_ISSUER"), hostId: required("PLOW_HOST_ID"),
    creatorId: required("PLOW_CREATOR_ID"), keys: createLocalJWKSet(jwks),
  };
}
export type TeamSettings = Awaited<ReturnType<typeof teamSettings>>;

export function teamGateway(team: Pick<TeamSettings, "origin" | "creatorId">) {
  return {
    mode: "local", bind: "loopback", reload: { mode: "off" },
    trustedProxies: ["127.0.0.1"],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: { userHeader: IDENTITY_HEADER, allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes: PEER_SCOPES } },
      identityScopes: { [team.creatorId]: ["operator.admin"] },
    },
    controlUi: { enabled: true, allowedOrigins: [team.origin] },
    // A role ceiling preserves the creator's identity grant; it grants no scopes itself.
    roles: { default: "teammate", definitions: {
      teammate: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin", ...PEER_SCOPES] },
    } },
  };
}
