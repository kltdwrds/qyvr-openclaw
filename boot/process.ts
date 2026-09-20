import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";

export async function startGateway(captureOutput = false, mcpUrl?: string) {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 30_000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const launch = (label: string, args: string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, args, options);
    children.add(child);
    child.on("error", error => { console.error(error); process.exitCode = 1; stop(); });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (!stopping && (label === "bridge" || code || signal)) {
        console.error(`plow-boot: ${label} exited code=${code} signal=${signal}`);
        process.exitCode = code || 1;
      }
      stop();
      if (!children.size) {
        clearTimeout(timer);
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    });
    return child;
  };
  if (mcpUrl) {
    const bridge = launch("bridge", ["/opt/plow/boot/mcp-bridge.js"], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { PLOW_MCP_URL: mcpUrl, PLOW_AGENT_TOKEN: process.env.PLOW_AGENT_TOKEN },
    });
    await Promise.race([once(bridge, "message"), once(bridge, "close").then(() => { throw new Error("MCP bridge closed before readiness"); })]);
  }
  return launch("gateway", ["/app/openclaw.mjs", "gateway"], {
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit", env: process.env,
  });
}
