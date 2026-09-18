export type Participant =
  | { type: "member"; uid: string; role: string }
  | { type: "agent"; relationship: string; line: { uid: string; provider_type?: string } };
export type Identity = {
  line: { uid: string };
  chats: { uid: string; status: string; participants: Participant[] }[];
  mcp_url?: string | null;
};

export function homeChat(identity: Identity) {
  if (!identity.line.uid) throw new Error("Identity is missing line uid");
  const homes = identity.chats.filter(chat => chat.status === "active" &&
    chat.participants.length === 2 &&
    chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === identity.line.uid) &&
    chat.participants.some(p => p.type === "member" && p.role === "owner"));
  if (homes.length > 1) throw new Error(`Expected one owner home chat; found ${homes.length}`);
  return homes[0];
}

export function renderConfig(identity: Identity, apiBase: string) {
  const home = homeChat(identity);
  if (!home) throw new Error("Expected one owner home chat; found 0");
  const owner = home.participants.find(p => p.type === "member" && p.role === "owner");
  if (owner?.type !== "member" || !owner.uid || !home.uid || !identity.line.uid) {
    throw new Error("Identity is missing home chat, line or owner uid");
  }
  const email = identity.chats.flatMap(chat => chat.participants).find(p =>
    p.type === "agent" && p.relationship === "self" && p.line.provider_type === "email");
  return {
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }, reload: { mode: "off" } },
    models: { providers: { plow: {
      baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
      request: { allowPrivateNetwork: true },
      models: [{ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", contextWindow: 262144, cost: { input: 0.45, output: 2.25 } }],
    } } },
    agents: { defaults: {
      workspace: "/var/lib/plow/workspace",
      model: { primary: "plow/moonshotai/kimi-k2.5" }, sandbox: { mode: "off" },
    } },
    ...(identity.mcp_url ? { mcp: { servers: { plow: {
      command: "node", args: ["/opt/plow/boot/mcp-bridge.js"],
      env: { PLOW_MCP_URL: identity.mcp_url, PLOW_AGENT_TOKEN: "${PLOW_AGENT_TOKEN}" },
    } } } } : {}),
    plugins: { load: { paths: ["/opt/plow/plugin"] }, entries: { plow: { enabled: true } } },
    channels: { plow: {
      apiBase, homeChatUid: home.uid, lineUid: identity.line.uid, ownerMemberUid: owner.uid,
      ...(email?.type === "agent" ? { emailLineUid: email.line.uid } : {}),
    } },
    session: { dmScope: "per-account-channel-peer", groupScope: "per-group" },
    bindings: [{ agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: owner.uid } }, session: { dmScope: "main" } }],
    commands: { ownerAllowFrom: [owner.uid] },
    memory: { search: { rememberAcrossConversations: true } },
    // An empty allowlist means unrestricted in OpenClaw.
    skills: { load: { extraDirs: ["/opt/plow/skills"] }, allowBundled: ["plow-no-bundled-skills"] },
    tools: { profile: "messaging", alsoAllow: ["read", "exec", "plow_start_thread", "plow_send_message"], deny: ["ask_user"] },
  };
}
