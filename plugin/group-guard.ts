// Decides whether a group message starts a turn, so agents sharing a Plow group text cannot reply to each other
// without end: another agent's message wakes this agent only when it names it, at most AGENT_TURN_CAP times per chat
// between a person's messages, and a bench agent ("named" mode) wakes for people only when named, under an hourly cap.
import type { Chat, Message } from "./transport.ts";

export type GroupMode = "all" | "named";
export const AGENT_TURN_CAP = 4;
export const HOURLY_CAP = 30;
const HOUR = 3_600_000;
const MAX_CHATS = 1000;

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 2);

export function nameWords(names: (string | null | undefined)[]): string[] {
  return [...new Set(names.flatMap(name => words(name ?? "")))];
}

export class GroupGuard {
  private readonly chats = new Map<string, { agentTurns: number; turns: number[] }>();
  private readonly mode: GroupMode;
  private readonly names: string[];
  constructor(mode: GroupMode, names: string[]) { this.mode = mode; this.names = names; }

  admit(chat: string, sender: "member" | "agent", text: string, now = Date.now()): boolean {
    let state = this.chats.get(chat);
    if (!state) {
      if (this.chats.size >= MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
      state = { agentTurns: 0, turns: [] };
      this.chats.set(chat, state);
    }
    state.turns = state.turns.filter(t => now - t < HOUR);
    const said = new Set(words(text));
    const named = this.names.some(name => said.has(name));
    if (sender === "member") {
      state.agentTurns = 0;
      if (this.mode === "named" && !named) return false;
    } else if (!named || state.agentTurns >= AGENT_TURN_CAP) return false;
    if (this.mode === "named" && state.turns.length >= HOURLY_CAP) return false;
    if (sender === "agent") state.agentTurns++;
    state.turns.push(now);
    return true;
  }
}

export function admitFor(accountId: string, guard: GroupGuard) {
  return (chat: Chat, message: Message) =>
    accountId !== "chat" || chat.participants.length <= 2 || guard.admit(chat.uid, message.sender.type, message.body ?? "");
}
