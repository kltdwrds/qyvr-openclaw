import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { teamSettings } from "./team.ts";
import { createAdapter } from "./adapter.ts";
import { renderConfig } from "./config.js";
import { identityFromApi } from "./identity.js";
import { renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

try {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  const shape = process.env.PLOW_AGENT_SHAPE;
  if (shape && !["personal", "teammate"].includes(shape)) throw new Error("Invalid PLOW_AGENT_SHAPE");
  const team = shape === "teammate" ? await teamSettings() : undefined;
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  if (!team) process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  const config = renderConfig(identity, base, team);
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  const prompt = await readFile(`/opt/plow/prompt/${team ? "teammate/" : ""}AGENTS.md`, "utf8");
  const renderedPrompt = await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN, team ? "the team's shared workstation" : undefined);
  for (const [path, content] of [
    ["/var/lib/plow/workspace/AGENTS.md", renderedPrompt],
    ["/var/lib/plow/openclaw.json", JSON.stringify(config, null, 2) + "\n"],
  ]) {
    try { await writeFile(path, content, { mode: 0o600, flag: team ? "wx" : "w" }); }
    catch (error) { if (!team || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  const adapter = team ? createAdapter(team) : undefined;
  if (adapter) await new Promise<void>((resolve, reject) => { adapter.once("error", reject); adapter.listen(team!.port, "0.0.0.0", resolve); });
  const gateway = await startGateway(false, identity.mcp_url ?? undefined);
  gateway.once("close", () => adapter?.close());
} catch (error) {
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
