import type { Chat } from "./transport.js";

type Requester = { senderId?: string; channel?: string; senderIsOwner?: boolean };
type Turn = { chat: Chat; senderId: string; isOwner: boolean };

export function allowsTool(active: Turn | undefined, context: { toolName?: string; channelId?: string; requester?: Requester }): boolean {
  const turn = active?.chat.uid === context.channelId ? active : undefined;
  const sender = context.requester?.senderId;
  const trusted = context.toolName !== "exec" && context.toolName !== "read" && context.toolName !== "plow_start_thread" && context.toolName !== "plow_send_message" && turn?.chat.trusted;
  if (sender) {
    if (context.requester?.channel && context.requester.channel !== "plow") return false;
    return Boolean(turn ? trusted || (sender === turn.senderId && turn.isOwner) : context.requester?.senderIsOwner);
  }
  return Boolean(turn && (turn.isOwner || trusted));
}
