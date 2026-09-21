export type Participant =
  | { type: "member"; uid: string; role: string }
  | { type: "agent"; relationship: string; line: { uid: string; provider_type?: string } };
export type Identity = {
  agent?: { name?: string | null };
  line: { uid: string };
  chats: { uid: string; status: string; participants: Participant[] }[];
  mcp_url?: string | null;
};

export function findOwnerChat(identity: Identity) {
  if (!identity.line.uid) throw new Error("Identity is missing line uid");
  const ownerChats = identity.chats.filter(chat => chat.status === "active" &&
    chat.participants.length === 2 &&
    chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === identity.line.uid) &&
    chat.participants.some(p => p.type === "member" && p.role === "owner"));
  if (ownerChats.length > 1) throw new Error(`Expected one owner's chat; found ${ownerChats.length}`);
  return ownerChats[0];
}

export function renderConfig(identity: Identity, apiBase: string) {
  const ownerChat = findOwnerChat(identity);
  if (!ownerChat) throw new Error("Expected one owner's chat; found 0");
  const owner = ownerChat.participants.find(p => p.type === "member" && p.role === "owner");
  if (owner?.type !== "member" || !owner.uid || !ownerChat.uid || !identity.line.uid) {
    throw new Error("Identity is missing the owner's chat, line or owner uid");
  }
  const name = identity.agent?.name;
  if (typeof name !== "string" || !name.trim()) throw new Error(`Identity has no usable agent.name: ${JSON.stringify(name)}`);
  const email = identity.chats.flatMap(chat => chat.participants).find(p =>
    p.type === "agent" && p.relationship === "self" && p.line.provider_type === "email");
  return {
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }, reload: { mode: "off" } },
    models: { providers: { plow: {
      baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
      request: { allowPrivateNetwork: true },
      models: [
        { id: "z-ai/glm-5.2", name: "GLM 5.2", contextWindow: 1048576, cost: { input: 0.5544, output: 1.7424 } },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1000000, cost: { input: 2.00, output: 10.00 } },
      ],
    } } },
    agents: { entries: { main: { identity: { name } } }, defaults: {
      workspace: "/var/lib/plow/workspace",
      model: { primary: "plow/z-ai/glm-5.2", fallbacks: ["plow/anthropic/claude-sonnet-5"] }, sandbox: { mode: "off" },
    } },
    ...(identity.mcp_url ? { mcp: { sessionIdleTtlMs: 300_000, servers: { plow: {
      url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
      headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
    } } } } : {}),
    plugins: { load: { paths: ["/opt/plow/plugin"] }, entries: { plow: { enabled: true } } },
    channels: { plow: {
      apiBase, ownerChatUid: ownerChat.uid, lineUid: identity.line.uid,
      ...(email?.type === "agent" ? { emailLineUid: email.line.uid } : {}),
    } },
    session: { dmScope: "per-account-channel-peer", groupScope: "per-group" },
    bindings: [{ agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: owner.uid } }, session: { dmScope: "main" } }],
    commands: { ownerAllowFrom: [owner.uid] },
    memory: { search: { rememberAcrossConversations: false } },
    // An empty allowlist means unrestricted in OpenClaw.
    skills: { load: { extraDirs: ["/opt/plow/skills"] }, allowBundled: ["plow-no-bundled-skills"] },
    // Keep workspace and durable memory writes local instead of routing them through the Mac relay.
    tools: { profile: "messaging", sessions: { visibility: "tree" }, alsoAllow: ["read", "write", "edit", "exec", "plow_start_thread"], deny: ["ask_user"] },
  };
}
