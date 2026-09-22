import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAdapter } from "../boot/adapter.ts";
import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";

const { privateKey, publicKey } = await generateKeyPair("EdDSA");
const rotated = await generateKeyPair("EdDSA");
const nextKey = { ...await exportJWK(rotated.publicKey), kid: "next" };
const key = { ...await exportJWK(publicKey), kid: "test" };
const team = { keys: createLocalJWKSet({ keys: [key, nextKey] }), issuer: "test-ingress", hostId: "test-host", creatorId: "account-creator", origin: "https://team.example", port: 0 };
const sign = (claims = {}) => new SignJWT({ sub: "account-member", client_ip: "192.0.2.10", ...claims })
  .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer(team.issuer).setAudience(team.hostId)
  .setIssuedAt().setExpirationTime("60s").sign(privateKey);

test("adapter verifies assertions before streaming, overwrites identity, and preserves upload bytes", async t => {
  const upstream = createServer((req, res) => {
    res.setHeader("x-seen-user", req.headers["x-plow-user-id"]!);
    res.setHeader("x-seen-scopes", req.headers["x-openclaw-scopes"]!);
    res.setHeader("x-seen-client", req.headers["x-forwarded-for"]!);
    assert.equal(req.headers["x-plow-assertion"], undefined);
    assert.equal(req.headers.authorization, undefined);
    req.pipe(res);
  }).listen(18789, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const adapter = createAdapter(team).listen(0, "127.0.0.1");
  await once(adapter, "listening");
  t.after(() => adapter.close());
  const address = adapter.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/upload`;
  const token = await sign();
  const bytes = Buffer.from([0, 255, 10, 13, 128]);
  const response = await fetch(url, { method: "POST", body: bytes, headers: {
    "x-plow-assertion": token, "x-plow-user-id": team.creatorId, "x-openclaw-scopes": "operator.admin",
    "x-forwarded-for": "127.0.0.1", authorization: "Bearer forged", origin: team.origin,
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("x-seen-user"), "account-member");
  assert.equal(response.headers.get("x-seen-client"), "192.0.2.10");
  assert.ok(!response.headers.get("x-seen-scopes")!.includes("operator.admin"));
  for (const assertion of ["", token.slice(0, -8) + "tampered", await new SignJWT({ sub: "account-member", client_ip: "192.0.2.10" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer(team.issuer).setAudience(team.hostId).setIssuedAt(1).setExpirationTime(2).sign(privateKey),
    await new SignJWT({ sub: "account-member", client_ip: "192.0.2.10" }).setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer("wrong").setAudience(team.hostId).setIssuedAt().setExpirationTime("60s").sign(privateKey),
    await new SignJWT({ sub: "account-member", client_ip: "192.0.2.10" }).setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer(team.issuer).setAudience("another-host").setIssuedAt().setExpirationTime("60s").sign(privateKey)]) {
    assert.equal((await fetch(url, { headers: { "x-plow-assertion": assertion } })).status, 401);
  }
  const rejectedUpgrade = new WebSocket(url.replace("http", "ws"), { headers: { "x-plow-user-id": team.creatorId } });
  const [, upgradeResponse] = await once(rejectedUpgrade, "unexpected-response");
  assert.equal(upgradeResponse.statusCode, 401);
  upgradeResponse.resume();
  rejectedUpgrade.on("error", () => {});
  rejectedUpgrade.terminate();
  const creator = await fetch(url, { headers: { "x-plow-assertion": await sign({ sub: team.creatorId }) } });
  assert.ok(creator.headers.get("x-seen-scopes")!.includes("operator.admin"));
  const rotatedAssertion = await new SignJWT({ sub: "account-member", client_ip: "192.0.2.11" })
    .setProtectedHeader({ alg: "EdDSA", kid: "next" }).setIssuer(team.issuer).setAudience(team.hostId)
    .setIssuedAt().setExpirationTime("60s").sign(rotated.privateKey);
  const rotatedResponse = await fetch(url, { headers: { "x-plow-assertion": rotatedAssertion } });
  assert.equal(rotatedResponse.status, 200);
  assert.equal(rotatedResponse.headers.get("x-seen-client"), "192.0.2.11");
  const loopback = await fetch(url, { headers: { "x-plow-assertion": await sign({ client_ip: "127.0.0.1" }) } });
  assert.equal(loopback.headers.get("x-seen-client"), "127.0.0.1");
});

test("teammate uses native memory defaults and grants administration only to the creator", () => {
  const config = renderConfig(probeIdentity, "http://api.example", team);
  assert.equal(config.memory, undefined);
  assert.equal(config.tools.sessions, undefined);
  assert.deepEqual(config.gateway.auth.identityScopes, { "account-creator": ["operator.admin"] });
  assert.equal(config.gateway.auth.token, undefined);
});
