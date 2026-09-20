import { createServer } from "node:http";

const url = process.env.PLOW_MCP_URL;
const token = process.env.PLOW_AGENT_TOKEN;
if (!url || !token) throw new Error("PLOW_MCP_URL and PLOW_AGENT_TOKEN are required");

// Preserve each client's MCP session and HTTP result; never replay a request.
createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    for (const key of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "last-event-id"]) {
      const value = request.headers[key];
      if (typeof value === "string") headers.set(key, value);
    }
    const upstream = await fetch(url, {
      method: request.method, redirect: "error", signal: AbortSignal.timeout(60_000), headers,
      body: ["GET", "HEAD"].includes(request.method!) ? undefined : Buffer.concat(chunks),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) response.setHeader(key, value);
    }
    response.writeHead(upstream.status).end(body);
  } catch {
    response.writeHead(502).end("Relay request failed");
  }
}).listen(18790, "127.0.0.1", () => process.send?.("ready"));
