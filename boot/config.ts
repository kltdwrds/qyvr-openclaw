export type Participant =
  | { type: "member"; uid: string; role: string }
  | { type: "agent"; relationship: string; line: { uid: string; provider_type?: string } };
export type Identity = {
  agent?: { name?: string | null };
  line: { uid: string };
  chats: { uid: string; status: string; participants: Participant[] }[];
  mcp_url?: string | null;
};

/** Nick's place in the qyvr homeroom: the Block-hosted Buzz community and its control plane. */
export const QYVR = {
  relayUrl: "https://qyvr.communities.buzz.xyz",
  controlUrl: "https://buzz.qyvr.ai",
  homeroom: "18a2b64f-e9b9-42ae-bb96-8b01ec8865dc",
  // Kyle's Buzz identity (npub1c2ug7a9j…): the only author whose mentions start a turn in v0.
  allowFrom: ["c2b88f74b2f2fed397726b430eb8020e514cfc6c7234bec9fa6d93f4f2769808"],
};

export function renderConfig(identity: Identity, apiBase: string, env: Record<string, string | undefined> = process.env) {
  const name = identity.agent?.name;
  if (typeof name !== "string" || !name.trim()) throw new Error(`Identity has no usable agent.name: ${JSON.stringify(name)}`);
  // Plow names the agent after its image slug; AGENT_NAME is the Index name it goes by in the homeroom.
  const homeroomName = env.AGENT_NAME?.trim() || name.trim();
  const email = identity.chats.flatMap(chat => chat.participants).find(p =>
    p.type === "agent" && p.relationship === "self" && p.line.provider_type === "email");
  return {
    meta: {},
    gateway: { mode: "local", bind: "loopback", controlUi: { enabled: false }, auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }, reload: { mode: "off" } },
    models: { providers: { plow: {
      baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
      request: { allowPrivateNetwork: true },
      models: [
        { id: "z-ai/glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 1048576, cost: { input: 0.5544, output: 1.7424 } },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", input: ["text", "image"], contextWindow: 1000000, cost: { input: 2.00, output: 10.00 } },
      ],
    } } },
    agents: { entries: { main: { identity: { name } } }, defaults: {
      workspace: "/var/lib/plow/workspace", skipBootstrap: true,
      model: { primary: "plow/z-ai/glm-5.2", fallbacks: ["plow/anthropic/claude-sonnet-5"] }, sandbox: { mode: "off" },
    } },
    ...(identity.mcp_url ? { mcp: { sessionIdleTtlMs: 300_000, servers: { plow: {
      url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
      headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
    } } } } : {}),
    plugins: { load: { paths: ["/opt/plow/plugin"] }, entries: { plow: { enabled: true } } },
    channels: {
      plow: {
        apiBase, lineUid: identity.line.uid,
        ...(email?.type === "agent" ? { emailLineUid: email.line.uid } : {}),
      },
      buzz: {
        relayUrl: QYVR.relayUrl, controlUrl: QYVR.controlUrl, allowFrom: QYVR.allowFrom, homeroom: QYVR.homeroom,
        name: homeroomName, handle: homeroomName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        about: env.AGENT_BLURB ?? "", harness: "openclaw", model: "glm-5.2",
      },
    },
    session: { dmScope: "per-account-channel-peer", groupScope: "per-group" },
    bindings: [{ agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } }, session: { dmScope: "main" } }],
    commands: { ownerAllowFrom: ["plow-owner"] },
    memory: { search: { rememberAcrossConversations: false } },
    // An empty allowlist means unrestricted in OpenClaw.
    skills: { load: { extraDirs: ["/opt/plow/skills"] }, allowBundled: ["plow-no-bundled-skills"] },
    // Keep workspace and durable memory writes local instead of routing them through the Mac relay.
    tools: { profile: "messaging", sessions: { visibility: "tree" }, alsoAllow: ["read", "write", "edit", "exec", "plow_start_thread", "qyvr_enroll"], deny: ["ask_user"] },
  };
}
