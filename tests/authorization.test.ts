import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chat } from "../plugin/transport.ts";
import { allowsTool } from "../plugin/authorization.ts";

const chat = { uid: "chat", trusted: false, participants: [{ type: "member", uid: "owner", role: "owner" }] } as Chat;

test("native MCP uses only its channel's active sender and trust", () => {
  const turn = { chat, senderId: "owner", isOwner: true };
  assert.equal(allowsTool(undefined, { channelId: "chat" }), false);
  assert.equal(allowsTool(undefined, { requester: { senderId: "owner", senderIsOwner: true, channel: "plow" } }), true);
  assert.equal(allowsTool(turn, { channelId: "chat" }), true);
  assert.equal(allowsTool(turn, { channelId: "other" }), false);
  assert.equal(allowsTool(turn, { channelId: "chat", requester: { senderId: "member", channel: "plow" } }), false);
  assert.equal(allowsTool({ chat, senderId: "member", isOwner: false }, { channelId: "chat" }), false);
  assert.equal(allowsTool({ chat: { ...chat, trusted: true }, senderId: "member", isOwner: false }, { channelId: "chat" }), true);
});

for (const requester of [false, true]) test(`exec, read and Plow sends are owner-only, MCP retains trust; requester=${requester}`, () => {
  for (const trusted of [false, true]) {
    for (const senderId of ["owner", "member"]) {
      const turn = { chat: { ...chat, trusted }, senderId, isOwner: senderId === "owner" };
      const context = { channelId: chat.uid, ...(requester ? { requester: { senderId, channel: "plow" } } : {}) };
      for (const toolName of ["exec", "read", "plow_start_thread", "plow_send_message"]) {
        assert.equal(allowsTool(turn, { ...context, toolName }), senderId === "owner");
      }
      assert.equal(allowsTool(turn, { ...context, toolName: "plow_mcp" }), senderId === "owner" || trusted);
    }
  }
  assert.equal(allowsTool(undefined, { toolName: "exec", channelId: chat.uid }), false);
});
