import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { renderConfig, findOwnerChat, type Identity } from "./config.js";
import { identityFromApi } from "./identity.js";
import { inboundEvents } from "./inbound.js";
import { renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

try {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  let identity: Identity | undefined;
  let waitingForOwner = false;
  for await (const _event of inboundEvents(base, process.env.PLOW_AGENT_TOKEN)) {
    const resolved = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN, !identity);
    if (!resolved) continue;
    identity = resolved;
    const ownerChat = findOwnerChat(identity);
    if (ownerChat) {
      if (waitingForOwner) {
        await mkdir("/var/lib/plow/plow-checkpoints", { recursive: true });
        await writeFile(`/var/lib/plow/plow-checkpoints/${ownerChat.uid}`, "", { flag: "wx" })
          .catch(error => { if (error.code !== "EEXIST") throw error; });
      }
      break;
    }
    waitingForOwner = true;
    console.log("plow-boot: waiting for the first inbound message");
  }
  if (!identity) throw new Error("Identity not resolved");
  const config = renderConfig(identity, base);
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN));
  await writeFile("/var/lib/plow/openclaw.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`plow-boot: identity resolved to ${config.channels.plow.ownerChatUid}`);
  await startGateway(false, identity.mcp_url ?? undefined);
} catch (error) {
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
