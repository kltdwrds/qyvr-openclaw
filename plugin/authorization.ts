import type { Chat } from "./transport.js";

type Requester = { senderId?: string; channel?: string; senderIsOwner?: boolean };

export class TurnAuthorization {
  private turns = new Map<string, { chat: Chat; senderId: string; isOwner: boolean }>();

  async run<T>(chat: Chat, senderId: string, dispatch: () => Promise<T>): Promise<T> {
    this.turns.set(chat.uid, { chat, senderId, isOwner: chat.participants.some(p => p.type === "member" && p.uid === senderId && p.role === "owner") });
    try { return await dispatch(); }
    finally { this.turns.delete(chat.uid); }
  }

  allows(context: { toolName?: string; channelId?: string; requester?: Requester }): boolean {
    const turn = context.channelId ? this.turns.get(context.channelId) : undefined;
    const sender = context.requester?.senderId;
    const trusted = context.toolName !== "exec" && context.toolName !== "read" && context.toolName !== "plow_start_thread" && context.toolName !== "plow_send_message" && turn?.chat.trusted;
    if (sender) {
      if (context.requester?.channel && context.requester.channel !== "plow") return false;
      return Boolean(turn ? trusted || turn.chat.participants.some(p => p.type === "member" && p.uid === sender && p.role === "owner") : context.requester?.senderIsOwner);
    }
    return Boolean(turn && (turn.isOwner || trusted));
  }
}
