import { setTimeout as sleep } from "node:timers/promises";

export async function waitForInbound(base: string, token: string): Promise<{ chatUid: string; messageUid: string }> {
  let backoff = 1_000;
  for (;;) {
    let socket: WebSocket | undefined;
    let setupTimer: NodeJS.Timeout | undefined;
    try {
      const response = await fetch(`${base}/v1/ws/ticket`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Ticket HTTP ${response.status}`);
      const { ticket } = await response.json() as { ticket: string };
      socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
      return await new Promise<{ chatUid: string; messageUid: string }>((resolve, reject) => {
        setupTimer = setTimeout(() => reject(new Error("WebSocket setup timed out")), 10_000);
        socket!.addEventListener("open", () => clearTimeout(setupTimer), { once: true });
        socket!.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
        socket!.addEventListener("close", event => reject(new Error(`WebSocket closed (${event.code})`)), { once: true });
        socket!.addEventListener("message", event => {
          try {
            const frame = JSON.parse(String(event.data));
            if (frame.event_type === "message_received" && frame.data?.message?.direction === "inbound") {
              resolve({ chatUid: frame.chat_id, messageUid: frame.data.message.uid });
            }
          } catch (error) { reject(error); }
        });
      });
    } catch (error) {
      console.error(`plow-boot: ${error instanceof Error ? error.message : String(error)}; reconnecting in ${backoff / 1000}s`);
    } finally {
      clearTimeout(setupTimer);
      socket?.close();
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}
