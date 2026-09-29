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

// Plow shows another Plow line in a group as a member with that line's number, not as an agent (rehearsal,
// 2026-09-29): the guard must recognise teammates by number.
const TEAM = ["+16503156536", "+16503156415", "+16503156604"];
const teamGroup = { uid: "t", participants: [
  { type: "agent", relationship: "self", line: { uid: "ln_x" } },
  { type: "member", uid: "kyle", role: "owner", provider_key: "+15550001111" },
  { type: "member", uid: "tony", role: "member", provider_key: "+16503156536" },
  { type: "member", uid: "bruce", role: "member", provider_key: "(650) 315-6415" },
] } as unknown as Chat;
const by = (uid: string, body: string) => ({ sender: { type: "member", uid }, body }) as unknown as Message;

test("a teammate's line counts as an agent even when Plow lists it as a member", () => {
  const admit = admitFor("chat", nick(), TEAM);
  assert.equal(admit(teamGroup, by("tony", "")), false, "a teammate's contact card");
  assert.equal(admit(teamGroup, by("tony", "Menu spec is ready.")), false, "an unnamed deliverable");
  assert.equal(admit(teamGroup, by("kyle", "sounds good")), true, "the owner still wakes Nick");
  assert.equal(admit(teamGroup, by("bruce", "Nick, the research is in.")), true, "numbers match in any format");
});

test("teammates who name each other stop at the cap until a person speaks", () => {
  const admit = admitFor("chat", nick(), TEAM);
  for (let i = 0; i < AGENT_TURN_CAP; i++) assert.equal(admit(teamGroup, by("tony", "Nick, thoughts?")), true);
  assert.equal(admit(teamGroup, by("bruce", "Nick, agreed?")), false);
  admit(teamGroup, by("kyle", "keep going"));
  assert.equal(admit(teamGroup, by("bruce", "Nick, agreed?")), true);
});
