import { on } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const WebSocket = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");

export async function* inboundEvents(base: string, token: string): AsyncGenerator<"connected" | "inbound"> {
  let backoff = 1_000;
  for (;;) {
    let socket: InstanceType<typeof WebSocket> | undefined;
    let setupTimer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let frames: ReturnType<typeof on> | undefined;
    try {
      const response = await fetch(`${base}/v1/ws/ticket`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Ticket HTTP ${response.status}`);
      const { ticket } = await response.json() as { ticket: string };
      socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
      // Buffer inbound frames even while the caller is fetching identity.
      frames = on(socket, "message", { close: ["close"] });
      setupTimer = setTimeout(() => socket!.terminate(), 10_000);
      let alive = true;
      socket.on("pong", () => { alive = true; });
      socket.on("open", () => {
        heartbeat = setInterval(() => {
          if (!alive) socket!.terminate();
          else { alive = false; socket!.ping(); }
        }, 30_000);
      });
      for await (const [raw] of frames) {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "connected") {
          clearTimeout(setupTimer);
          yield "connected";
        } else if (frame.event_type === "message_received" && frame.data?.message?.direction === "inbound") {
          yield "inbound";
        }
      }
      throw new Error("WebSocket closed");
    } catch (error) {
      console.error(`plow-boot: ${error instanceof Error ? error.message : String(error)}; reconnecting in ${backoff / 1000}s`);
    } finally {
      clearTimeout(setupTimer);
      clearInterval(heartbeat);
      // A pending upgrade emits an error when terminated.
      socket?.on("error", () => {});
      socket?.terminate();
      await frames?.return();
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}
