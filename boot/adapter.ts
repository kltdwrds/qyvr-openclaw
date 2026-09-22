import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { jwtVerify } from "jose";
import { IDENTITY_HEADER, PEER_SCOPES, type TeamSettings } from "./team.ts";

export function createAdapter(team: TeamSettings) {
  async function headers(req: IncomingMessage) {
    const assertion = req.headers["x-plow-assertion"];
    if (typeof assertion !== "string") throw new Error("Missing assertion");
    const { payload } = await jwtVerify(assertion, team.keys, {
      algorithms: ["EdDSA"], issuer: team.issuer, audience: team.hostId,
      requiredClaims: ["sub", "iat", "exp"], maxTokenAge: "60s",
    });
    if (typeof payload.sub !== "string" || !/^[\x21-\x7e]+$/.test(payload.sub) ||
        typeof payload.client_ip !== "string" || !isIP(payload.client_ip) ||
        payload.exp! - payload.iat! > 60) throw new Error("Invalid identity claims");
    if (req.headers.origin && req.headers.origin !== team.origin) throw new Error("Unexpected origin");
    const outgoing: OutgoingHttpHeaders = { ...req.headers };
    for (const name of Object.keys(outgoing)) {
      if (name.startsWith("x-plow-") || name === "x-openclaw-scopes" || name.startsWith("x-forwarded-") ||
          ["forwarded", "x-real-ip", "authorization", "proxy-authorization", "x-exedev-authorization"].includes(name)) delete outgoing[name];
    }
    const url = new URL(team.origin);
    outgoing.host = url.host;
    outgoing[IDENTITY_HEADER] = payload.sub;
    outgoing["x-openclaw-scopes"] = (payload.sub === team.creatorId ? ["operator.admin", ...PEER_SCOPES] : PEER_SCOPES).join(",");
    // Preserve even a signed loopback address: the Gateway must reject bad ingress attribution.
    outgoing["x-forwarded-for"] = payload.client_ip;
    outgoing["x-forwarded-host"] = url.host;
    outgoing["x-forwarded-proto"] = url.protocol.slice(0, -1);
    return { outgoing, expires: payload.exp! * 1000 };
  }
  const server = createServer(async (req, res) => {
    let verified;
    try { verified = await headers(req); }
    catch { res.writeHead(401).end("Invalid dashboard assertion\n"); return; }
    const upstream = request({ hostname: "127.0.0.1", port: 18789, path: req.url, method: req.method, headers: verified.outgoing }, response => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", async (req, socket, head) => {
    let verified;
    try { verified = await headers(req); }
    catch { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    const upstream = request({ hostname: "127.0.0.1", port: 18789, path: req.url, headers: verified.outgoing });
    const expiry = setTimeout(() => { upstream.destroy(); socket.destroy(); }, Math.max(0, verified.expires - Date.now()));
    socket.on("close", () => { clearTimeout(expiry); upstream.destroy(); });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("response", response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); response.resume(); });
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      const raw = response.rawHeaders;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Array.from({ length: raw.length / 2 }, (_, i) => `${raw[i * 2]}: ${raw[i * 2 + 1]}\r\n`).join("")}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.on("close", () => peer.destroy());
      peer.on("error", () => socket.destroy());
      peer.on("close", () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.end();
  });
  return server;
}
