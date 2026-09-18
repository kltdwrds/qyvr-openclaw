import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chat } from "../plugin/transport.ts";
import { TurnAuthorization } from "../plugin/authorization.ts";

const chat = { uid: "chat", trusted: false, participants: [{ type: "member", uid: "owner", role: "owner" }] } as Chat;

test("native MCP uses only its channel's active sender and trust", async () => {
  const policy = new TurnAuthorization();
  assert.equal(policy.allows({ channelId: "chat" }), false);
  assert.equal(policy.allows({ requester: { senderId: "owner", senderIsOwner: true, channel: "plow" } }), true);
  await policy.run(chat, "owner", async () => {
    assert.equal(policy.allows({ channelId: "chat" }), true);
    assert.equal(policy.allows({ channelId: "other" }), false);
    assert.equal(policy.allows({ channelId: "chat", requester: { senderId: "member", channel: "plow" } }), false);
  });
  assert.equal(policy.allows({ channelId: "chat" }), false);
  await policy.run(chat, "member", async () => assert.equal(policy.allows({ channelId: "chat" }), false));
  await policy.run({ ...chat, trusted: true }, "member", async () => assert.equal(policy.allows({ channelId: "chat" }), true));
});

test("failed turns cannot leave authorization behind", async () => {
  const policy = new TurnAuthorization();
  await assert.rejects(policy.run(chat, "owner", async () => { throw new Error("failed"); }));
  assert.equal(policy.allows({ channelId: "chat" }), false);
});

for (const requester of [false, true]) test(`exec, read and Plow sends are owner-only, MCP retains trust; requester=${requester}`, async () => {
  const policy = new TurnAuthorization();
  for (const trusted of [false, true]) {
    for (const senderId of ["owner", "member"]) {
      await policy.run({ ...chat, trusted }, senderId, async () => {
        const context = { channelId: chat.uid, ...(requester ? { requester: { senderId, channel: "plow" } } : {}) };
        assert.equal(policy.allows({ ...context, toolName: "exec" }), senderId === "owner");
        assert.equal(policy.allows({ ...context, toolName: "read" }), senderId === "owner");
        assert.equal(policy.allows({ ...context, toolName: "plow_start_thread" }), senderId === "owner");
        assert.equal(policy.allows({ ...context, toolName: "plow_send_message" }), senderId === "owner");
        assert.equal(policy.allows({ ...context, toolName: "plow_mcp" }), senderId === "owner" || trusted);
      });
    }
  }
  assert.equal(policy.allows({ toolName: "exec", channelId: chat.uid }), false);
});
