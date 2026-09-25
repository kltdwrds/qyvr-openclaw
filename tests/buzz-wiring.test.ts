import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import entry from "../plugin/index.ts";
import { renderConfig } from "../boot/config.ts";

const KYLE = "c2b88f74b2f2fed397726b430eb8020e514cfc6c7234bec9fa6d93f4f2769808";
const identity = { agent: { name: "Nick Fury" }, line: { uid: "ln_p2" }, chats: [] };

for (const mode of ["full", "discovery"]) test(`${mode} registers the buzz channel beside plow, plow last`, () => {
  const ids: string[] = [];
  entry.register({ registrationMode: mode, runtime: {}, logger: { info() {} }, on() {}, registerTool() {},
    registerChannel(value: { plugin: { id: string } }) { ids.push(value.plugin.id); } } as never);
  assert.deepEqual(ids, ["buzz", "plow"]);
});

test("the manifest declares the buzz channel and its config", async () => {
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.channels, ["plow", "buzz"]);
  assert.deepEqual(manifest.channelConfigs.buzz.schema.required, ["provider", "respondTo", "name", "handle", "about", "harness", "model"]);
  assert.deepEqual(manifest.channelConfigs.buzz.schema.properties.avatar, { type: "string" });
});

const nick = { BUZZ_ATTESTATION_PROVIDER: "https://buzz.qyvr.ai", BUZZ_RESPOND_TO: `${KYLE}, `, AGENT_NAME: "Nick Fury",
  AGENT_BLURB: "Send me an initiative and I'll assemble you a team", AGENT_AVATAR: "https://example.test/nick.png" };

test("an image that names an attestation provider joins Buzz; Plow routing is unchanged", () => {
  // Plow names the agent after its image slug; the Index name in AGENT_NAME is who it is in Buzz.
  const config = renderConfig({ ...identity, agent: { name: "qyvr-openclaw" } }, "http://api:8000", nick);
  assert.deepEqual(config.channels.buzz, {
    provider: "https://buzz.qyvr.ai", respondTo: [KYLE], name: "Nick Fury", handle: "nick-fury",
    about: "Send me an initiative and I'll assemble you a team", avatar: "https://example.test/nick.png", harness: "openclaw", model: "glm-5.2",
  });
  assert.deepEqual(config.bindings.map(b => b.match.channel), ["plow"]);
  assert.ok(config.tools.alsoAllow.includes("qyvr_enroll"));
});

test("without an attestation provider nothing about Buzz is configured", () => {
  const config = renderConfig(identity, "http://api:8000", { AGENT_NAME: "Nick Fury" });
  assert.ok(!("buzz" in config.channels));
  assert.ok(!config.tools.alsoAllow.includes("qyvr_enroll"));
});

test("qyvr_enroll hands the model a fresh approval link", async t => {
  const root = await mkdtemp(`${tmpdir()}/qyvr-enroll-`);
  t.after(() => rm(root, { recursive: true }));
  process.env.OPENCLAW_STATE_DIR = root;
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "qyvr_enroll") factory = value; } } as never);
  t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/v1/attest")
    ? Response.json({ error: "unknown_agent", message: "enroll first" }, { status: 403 })
    : Response.json({ url: "https://buzz.qyvr.ai/enroll/abc", expires_at: 1 }));
  const tool = factory!({ config: renderConfig(identity, "http://api:8000", nick) });
  const r = await tool.execute("call", {});
  assert.match(r.content[0]!.text, /Approve me into the qyvr homeroom: https:\/\/buzz\.qyvr\.ai\/enroll\/abc/);
});
