// Decides whether a message starts a turn, so agents sharing a Plow group text cannot reply to each other without end
// and nobody can run up the line's bill: another agent's message wakes this agent only when it names it, at most
// AGENT_TURN_CAP times per chat between a person's messages; a person addressing only a teammate does not wake it; a
// bench agent ("named" mode) wakes for people only when named; and hourly and daily ceilings bound every chat and the
// whole line. Names are first names only ("Tony", "Nick"): surnames like Banner and Stark are ordinary words.
import type { Chat, Member, Message } from "./transport.ts";

export type GroupMode = "all" | "named";
export const AGENT_TURN_CAP = 1;
export const HOURLY_CAP = 30;
export const ALL_HOURLY_CAP = 60;
export const LINE_HOURLY_CAP = 120;
export const DIRECT_DAILY_CAP = 5;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_CHATS = 1000;

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 2);

/** The call name of each name: its first word ("Tony Stark" is called "tony"). */
export function nameWords(names: (string | null | undefined)[]): string[] {
  return [...new Set(names.flatMap(name => words(name ?? "").slice(0, 1)))];
}

export class GroupGuard {
  private readonly chats = new Map<string, { agentTurns: number; turns: number[] }>();
  private lineTurns: number[] = [];
  private readonly mode: GroupMode;
  private readonly names: string[];
  private readonly teammates: string[];
  /** `teammates` are the other agents' call names: in "all" mode a person addressing only them does not wake this agent. */
  constructor(mode: GroupMode, names: string[], teammates: string[] = []) {
    this.mode = mode; this.names = names; this.teammates = teammates.filter(word => !names.includes(word));
  }

  private state(chat: string) {
    let state = this.chats.get(chat);
    if (!state) {
      if (this.chats.size >= MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
      state = { agentTurns: 0, turns: [] };
      this.chats.set(chat, state);
    }
    return state;
  }

  /** Takes a turn under the line-wide ceiling (named mode) and records it. */
  private take(turns: number[], now: number): boolean {
    this.lineTurns = this.lineTurns.filter(t => now - t < HOUR);
    if (this.mode === "named" && this.lineTurns.length >= LINE_HOURLY_CAP) return false;
    this.lineTurns.push(now);
    turns.push(now);
    return true;
  }

  admit(chat: string, sender: "member" | "agent", text: string, now = Date.now()): boolean {
    const state = this.state(chat);
    state.turns = state.turns.filter(t => now - t < HOUR);
    const said = new Set(words(text));
    const named = this.names.some(name => said.has(name));
    if (sender === "member") {
      state.agentTurns = 0;
      if (this.mode === "named" && !named) return false;
      if (!named && this.teammates.some(name => said.has(name))) return false;
    } else if (!named || state.agentTurns >= AGENT_TURN_CAP) return false;
    if (state.turns.length >= (this.mode === "named" ? HOURLY_CAP : ALL_HOURLY_CAP)) return false;
    if (!this.take(state.turns, now)) return false;
    if (sender === "agent") state.agentTurns++;
    return true;
  }

  /** A direct text from someone other than the owner: at most DIRECT_DAILY_CAP turns per chat per day. */
  admitDirect(chat: string, now = Date.now()): boolean {
    const state = this.state(`direct:${chat}`);
    state.turns = state.turns.filter(t => now - t < DAY);
    return state.turns.length < DIRECT_DAILY_CAP && this.take(state.turns, now);
  }
}

const digits = (phone: string | undefined) => (phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/**
 * Plow lists another Plow line in a group as a member with that line's number, not as an agent, so teammates are
 * recognised by number: `team` is the team's line numbers (PLOW_TEAM_NUMBERS), in any format.
 */
export function admitFor(accountId: string, guard: GroupGuard, team: string[] = []) {
  const teammates = new Set(team.map(digits).filter(Boolean));
  return (chat: Chat, message: Message) => {
    if (accountId !== "chat") return true;
    const sender = message.sender;
    const member = sender.type === "member"
      ? chat.participants.find((p): p is Member => p.type === "member" && p.uid === sender.uid) ?? sender
      : undefined;
    if (chat.participants.length <= 2) return member?.role === "owner" || guard.admitDirect(chat.uid);
    const number = sender.type === "member" ? sender.provider_key ?? member?.provider_key : undefined;
    const kind = sender.type === "agent" || teammates.has(digits(number)) ? "agent" : "member";
    return guard.admit(chat.uid, kind, message.body ?? "");
  };
}
