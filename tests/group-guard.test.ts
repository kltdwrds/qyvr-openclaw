import assert from "node:assert/strict";
import { test } from "node:test";
import { GroupGuard, nameWords, admitFor, AGENT_TURN_CAP, HOURLY_CAP } from "../plugin/group-guard.ts";
import type { Chat, Message } from "../plugin/transport.ts";

const tony = () => new GroupGuard("named", nameWords(["Tony Stark"]));
const nick = () => new GroupGuard("all", nameWords(["Nick Fury", "qyvr-openclaw"]));

test("an agent's message starts a turn only when it names this agent", () => {
  const g = nick();
  assert.equal(g.admit("c", "agent", "Delivery confirmed, I'm here."), false);
  assert.equal(g.admit("c", "agent", "Nick, the spec is posted."), true);
});

test("a line's contact card (an agent message with no text) starts no turn", () => {
  assert.equal(nick().admit("c", "agent", ""), false);
  assert.equal(tony().admit("c", "agent", ""), false);
});

test("names count through punctuation and possessives, never inside other words", () => {
  const g = tony();
  for (const text of ["@Tony, go", "Tony's turn", "STARK!", "over to tony."]) assert.equal(g.admit(`c-${text}`, "member", text), true, text);
  for (const text of ["Tonya said hi", "starkly put", "anthony"]) assert.equal(g.admit(`c-${text}`, "member", text), false, text);
});

test("a person's message: always a turn in all mode, only when named in named mode", () => {
  assert.equal(nick().admit("c", "member", "sounds good"), true);
  assert.equal(tony().admit("c", "member", "sounds good"), false);
  assert.equal(tony().admit("c", "member", "Tony, make it blue"), true);
});

test("agent-started turns stop at the cap until a person speaks", () => {
  const g = nick();
  for (let i = 0; i < AGENT_TURN_CAP; i++) assert.equal(g.admit("c", "agent", "thanks Nick"), true);
  assert.equal(g.admit("c", "agent", "thanks Nick"), false);
  assert.equal(g.admit("other", "agent", "thanks Nick"), true);
  g.admit("c", "member", "ok team");
  assert.equal(g.admit("c", "agent", "thanks Nick"), true);
});

test("named mode takes at most HOURLY_CAP turns per chat per rolling hour", () => {
  const g = tony();
  const t0 = 1_000_000;
  for (let i = 0; i < HOURLY_CAP; i++) assert.equal(g.admit("c", "member", "Tony?", t0 + i), true);
  assert.equal(g.admit("c", "member", "Tony?", t0 + HOURLY_CAP), false);
  assert.equal(g.admit("c", "member", "Tony?", t0 + 3_600_001 + HOURLY_CAP), true);
});

const group = (n: number) => ({ uid: "g", participants: Array.from({ length: n }, () => ({ type: "member" })) }) as unknown as Chat;
const from = (type: "member" | "agent", body: string) => ({ sender: { type }, body }) as unknown as Message;

test("admitFor filters only group chats on the chat account", () => {
  const admit = admitFor("chat", tony());
  assert.equal(admit(group(2), from("member", "hello")), true, "direct texts always reach the agent");
  assert.equal(admit(group(4), from("member", "hello")), false);
  assert.equal(admitFor("email", tony())(group(4), from("member", "hello")), true, "email is never filtered");
});
