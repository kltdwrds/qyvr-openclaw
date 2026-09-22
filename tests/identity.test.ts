import assert from "node:assert/strict";
import { test } from "node:test";
import { identityFromApi } from "../boot/identity.ts";

for (const status of [401, 403, 429, 503]) test(`identity HTTP ${status} surfaces without polling`, async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? new Response(null, { status })
    : Response.json({ line: { uid: "line" }, chats: [] }));
  await assert.rejects(identityFromApi("http://fixture", "test-token"), new RegExp(`HTTP ${status}`));
  assert.equal(calls, 1);
});

test("identity does not swallow malformed JSON", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(identityFromApi("http://fixture", "test-token"), SyntaxError);
});

for (const body of ["null", "{}"])
  test(`identity refuses malformed shape: ${body}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(identityFromApi("http://fixture", "test-token"), TypeError);
  });

test("boot uses the identity endpoint that includes agent.name", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "http://fixture/v1/agents/me");
    return Response.json({ agent: { name: "Juniper" }, line: { uid: "line" }, chats: [] });
  });
  assert.equal((await identityFromApi("http://fixture", "test-token")).agent?.name, "Juniper");
});
