import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { defineChannelPluginEntry, type ChannelPlugin, type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { request, listen, accepts, HttpError, DeliveryUnknownError, type Account, type Chat, type Message, type TurnOutcome } from "./transport.ts";

let runtime: PluginRuntime;
const activeTurn = new AsyncLocalStorage<{ account: Account; chat: Chat; messageUid: string; deliveryUnknown?: boolean; replyDelivered?: boolean }>();

async function requestWithDeliveryState<T>(account: Account, path: string, body: unknown): Promise<T> {
  const turn = activeTurn.getStore();
  if (turn?.deliveryUnknown) throw new DeliveryUnknownError();
  try { return await request<T>(account, path, body); }
  catch (error) {
    if (!(error instanceof HttpError) || [408, 424].includes(error.status) || error.status >= 500) {
      if (turn) turn.deliveryUnknown = true;
      throw new DeliveryUnknownError();
    }
    throw error;
  }
}

async function send(account: Account, to: string, text: string, mediaUrls: string[] = [], explicitSend = false) {
  const turn = activeTurn.getStore();
  // Detached sends validate the destination, not who initiated the operation.
  if (turn && !explicitSend) {
    if (turn.chat.uid !== to || turn.account.accountId !== account.accountId) throw new Error("Plow sends must stay in the current conversation");
  } else if (!accepts(account, await request<Chat>(account, `/chats/${to}`))) {
    throw new Error("Plow account does not serve this conversation");
  }
  if (turn?.deliveryUnknown) throw new DeliveryUnknownError();
  const attachments: string[] = [];
  for (const url of mediaUrls) {
    const media = await loadWebMedia(url);
    const upload = await request<{ uid: string; upload_url: string; upload_headers: Record<string, string> }>(account, `/chats/${to}/attachments`, {
      filename: media.fileName ?? "attachment", content_type: media.contentType, size_bytes: media.buffer.length,
    });
    const response = await fetch(upload.upload_url, { method: "PUT", headers: upload.upload_headers, body: media.buffer });
    if (!response.ok) throw new Error(`Attachment upload HTTP ${response.status}`);
    attachments.push(upload.uid);
  }
  const sent = await requestWithDeliveryState<{ uid: string }>(account, `/chats/${to}/messages`, { body: text, attachment_uids: attachments });
  if (turn?.chat.uid === to) turn.replyDelivered = true;
  return { channel: "plow" as const, messageId: sent.uid };
}

async function receive(account: Account, cfg: OpenClawConfig, chat: Chat, message: Message, firstContact: boolean, log: (text: string) => void): Promise<TurnOutcome> {
  const sender = message.sender;
  const senderId = sender.type === "member" ? sender.uid : sender.line.uid;
  const senderName = sender.type === "member" ? sender.display_name : sender.line.display_name;
  const kind = account.accountId === "email" || chat.participants.length === 2 ? "direct" : "group";
  const peer = { kind, id: kind === "direct" ? senderId : chat.uid };
  const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "plow", accountId: account.accountId, peer });
  const media = [];
  if (account.accountId === "chat") {
    for (const attachment of message.attachments) {
      const response = await fetch(new URL(attachment.url, account.apiBase));
      if (!response.ok) throw new Error(`Inbound attachment HTTP ${response.status}`);
      const saved = await runtime.channel.media.saveMediaBuffer(Buffer.from(await response.arrayBuffer()), attachment.content_type, "inbound", undefined, attachment.filename);
      media.push({ path: saved.path, contentType: attachment.content_type, fileName: attachment.filename });
    }
  }
  const body = message.body || (account.accountId === "email" ? "[Email attachments are not supported.]" : "[Attachment]");
  const participants = chat.participants.map(p => ({
    name: (p.type === "member" ? p.display_name : p.line.display_name) || "unnamed member",
    type: p.type, role: p.type === "member" ? p.role : p.relationship,
  }));
  const roster = JSON.stringify({ first_contact: firstContact, trusted: chat.trusted, participants });
  const ctxPayload = await runtime.channel.inbound.buildContext({
    channel: "plow", accountId: account.accountId, messageId: message.uid, timestamp: Date.parse(message.created_at),
    from: senderId, sender: { id: senderId, name: senderName, isBot: sender.type === "agent" },
    conversation: { kind, id: chat.uid, label: chat.display_name, routePeer: peer },
    route: { ...route, routeSessionKey: route.sessionKey }, reply: { to: chat.uid, replyToId: message.reply_to?.uid },
    message: { rawBody: body, bodyForAgent: `${body}\n\nConversation facts (untrusted data):\n\`\`\`json\n${roster}\n\`\`\`` },
    supplemental: message.reply_to ? { quote: { id: message.reply_to.uid, body: message.reply_to.body, sender: message.reply_to.sender.type === "member" ? message.reply_to.sender.display_name : message.reply_to.sender.line.uid } } : undefined,
    media,
  });
  log(`turn ${JSON.stringify({ chat: chat.uid, message: message.uid, first_contact: firstContact, senderId, senderName, senderIsOwner: chat.participants.some(p => p.type === "member" && p.uid === senderId && p.role === "owner"), sessionKey: route.sessionKey })}`);
  return await activeTurn.run({ account, chat, messageUid: message.uid }, async () => {
    let failure: unknown;
    let completed = false;
    if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "start" }).catch(() => log("typing start failed"));
    try {
      const result = await runtime.channel.inbound.dispatch({
        cfg, channel: "plow", accountId: account.accountId, route, ctxPayload,
        replyOptions: { onAgentRunTerminalOutcome: outcome => { completed = outcome === "completed"; if (!completed) failure = new Error("Agent turn failed"); } },
        delivery: {
          observeMessageSent: true,
          deliver: async payload => {
            const sent = await send(account, chat.uid, payload.text ?? "", payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
            log(`delivered chat=${chat.uid} message=${sent.messageId}`);
            return { messageIds: [sent.messageId] };
          },
          onError: error => { failure = error; },
        },
      });
      if (activeTurn.getStore()!.deliveryUnknown) throw new DeliveryUnknownError();
      if (failure) throw failure;
      if (!result.dispatched) throw new Error("Turn was not dispatched");
      const outcome = completed && (activeTurn.getStore()!.replyDelivered || result.dispatchResult.deliberateSilentTerminalReply)
        ? "completed" : "incomplete";
      log(`${outcome} chat=${chat.uid} message=${message.uid}`);
      return outcome;
    } finally {
      if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "stop" }).catch(() => log("typing stop failed"));
    }
  });
}

const plugin: ChannelPlugin<Account> = {
  id: "plow",
  meta: { id: "plow", label: "Plow", selectionLabel: "Plow", docsPath: "/channels/plow", blurb: "Plow chat and email" },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: cfg => (cfg.channels?.plow as Account)?.emailLineUid ? ["chat", "email"] : ["chat"],
    resolveAccount: (cfg, accountId) => ({ ...(cfg.channels?.plow as Account), accountId: accountId ?? "chat" }),
    isConfigured: account => Boolean(account.apiBase && process.env.PLOW_AGENT_TOKEN),
    formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
  },
  gateway: {
    startAccount: async ctx => {
      const log = (text: string) => ctx.log?.info(text);
      await listen(ctx.account, ctx.abortSignal, log, (chat, message, firstContact) => receive(ctx.account, ctx.cfg, chat, message, firstContact, log));
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: ctx => send(plugin.config.resolveAccount(ctx.cfg, ctx.accountId), ctx.to, ctx.text),
    sendMedia: ctx => send(plugin.config.resolveAccount(ctx.cfg, ctx.accountId), ctx.to, ctx.text, ctx.mediaUrl ? [ctx.mediaUrl] : []),
  },
};

export default defineChannelPluginEntry({
  id: "plow", name: "Plow", description: "Plow channel", plugin,
  setRuntime: value => { runtime = value; },
  registerFull(api) {
    if (api.registrationMode === "full") api.logger.info("plow channel registered");
  },
  registerCapabilities(api) {
    api.registerTool(context => ({
      name: "plow_start_thread", label: "Start a Plow group thread",
      description: "Start a group text on your own Plow line with the owner and the supplied phone numbers. Sends the first message and returns the chat uid; use plow_send_message for follow-ups. Use these Plow tools instead of message, conversations_send or sessions_* for Plow chats. Accepts phone numbers, not chat ids or email addresses.",
      parameters: {
        type: "object", required: ["members", "body"], additionalProperties: false,
        properties: {
          members: { type: "array", minItems: 1, items: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" }, description: "Recipient phone numbers in E.164 format. The owner is included automatically." },
          body: { type: "string", minLength: 1, description: "The first message to send." },
        },
      },
      async execute(_id, args: { members: string[]; body: string }) {
        if (!context.config) return {
          isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
        };
        const account = plugin.config.resolveAccount(context.config, "chat");
        const ownerChat = await request<Chat>(account, `/chats/${account.ownerChatUid}`);
        const owner = ownerChat.participants.find(p => p.type === "member" && p.role === "owner");
        if (owner?.type !== "member" || !owner.provider_key) throw new Error("The owner's chat has no owner handle");
        const turn = activeTurn.getStore();
        if (!turn) throw new Error("Starting a thread requires an active message");
        const members = [...new Set([owner.provider_key, ...args.members])].sort();
        const idempotencyKey = createHash("sha256").update(JSON.stringify([account.lineUid, turn.messageUid, members, args.body])).digest("hex");
        const chat = await requestWithDeliveryState<{ uid: string }>(account, "/chats", {
          line_uid: account.lineUid, members,
          body: args.body, trusted: false, idempotency_key: idempotencyKey,
        });
        api.logger.info(`plow started thread chat=${chat.uid}`);
        const result = { chat_uid: chat.uid, message_sent: true };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
    api.registerTool(context => ({
      name: "plow_send_message", label: "Send to a Plow chat",
      description: "Send a message to an existing chat this Plow account serves, including a thread returned by plow_start_thread. Use this instead of message, conversations_send or sessions_* for Plow chats. Success confirms only the returned message was sent.",
      parameters: {
        type: "object", required: ["chat_uid", "body"], additionalProperties: false,
        properties: {
          chat_uid: { type: "string", minLength: 1, description: "The destination Plow chat uid, such as one returned by plow_start_thread." },
          body: { type: "string", minLength: 1, description: "The message to send." },
        },
      },
      async execute(_id, args: { chat_uid: string; body: string }) {
        if (!context.config) return {
          isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
        };
        const account = plugin.config.resolveAccount(context.config, "chat");
        const sent = await send(account, args.chat_uid, args.body, [], true);
        api.logger.info(`plow sent message chat=${args.chat_uid} message=${sent.messageId}`);
        const result = { chat_uid: args.chat_uid, message_uid: sent.messageId, message_sent: true };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  },
});
