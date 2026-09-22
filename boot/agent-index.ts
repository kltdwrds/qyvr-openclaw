import { spawn } from "node:child_process";

/** Where the Index client keeps this install's id and key. It reads `HERMES_HOME`. */
const STATE_DIR = "/var/lib/plow/agent-index";
const CLIENT = "/opt/plow/agent-index/agent_index_client.py";
const REPORT_INTERVAL_MS = 5 * 60_000;
/** `status` says 0 registered, 3 not, 2 cannot tell — registering twice mints a second key. */
const NOT_REGISTERED = 3;

export type Run = (args: string[]) => Promise<number | null>;

const runClient: Run = args => new Promise(resolve => {
  const child = spawn("python3", [CLIENT, ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, HERMES_HOME: STATE_DIR },
  });
  child.on("error", error => { console.error(`plow-boot: agent-index: ${error.message}`); resolve(null); });
  child.on("close", code => resolve(code));
});

/** Report this agent's token usage to the Agent Index, every five minutes.
 *
 * The image carries the reporter so every agent built on this base lands on
 * the board without wiring one up. `AGENT_ID` is what a report is FOR, and an
 * image built without it is a builder saying no: no id, no reporting, no
 * registration of a page under a name nobody chose.
 *
 * Registration is not idempotent — it mints a fresh key each call — so the
 * client is asked whether this install already has one, and anything but a
 * clear "no" is left alone. A failed pass is logged and retried on the next
 * tick: usage is telemetry, and it never touches the agent it reports on.
 */
export async function startAgentIndex(run: Run = runClient): Promise<NodeJS.Timeout | undefined> {
  const agent = process.env.AGENT_ID;
  if (!agent) return;
  const report = async () => {
    try {
      if ((await run(["status"])) === NOT_REGISTERED) {
        await run(["--register", "--agent", agent, "--runtime", "openclaw"]);
      }
      await run(["--agent", agent]);
    } catch (error) {
      console.error(`plow-boot: agent-index pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await report();
  const timer = setInterval(report, REPORT_INTERVAL_MS);
  timer.unref();
  return timer;
}
