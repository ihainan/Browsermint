import { IncomingMessage, ServerResponse } from "http";
import { Duplex } from "stream";
import net from "net";
import httpProxy from "http-proxy";
import jwt from "jsonwebtoken";
import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/client.js";
import { config } from "../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionTokenPayload {
  sub: string;
  sessionId: string;
  type: string;
}

// ─── Proxy Server (singleton) ─────────────────────────────────────────────────

export const proxyServer = httpProxy.createProxyServer({});

proxyServer.on("error", (err, _req, res) => {
  console.error("Proxy error:", err.message);
  if (res instanceof net.Socket) {
    res.destroy();
  } else if (res instanceof ServerResponse && !res.headersSent) {
    res.writeHead(502);
    res.end("Bad Gateway");
  }
});

// ─── Session Token Validation ─────────────────────────────────────────────────

async function validateSessionToken(
  token: string
): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const payload = jwt.verify(
      token,
      config.JWT_SESSION_TOKEN_SECRET
    ) as SessionTokenPayload;
    if (payload.type !== "session") return null;
    return { userId: payload.sub, sessionId: payload.sessionId };
  } catch {
    return null;
  }
}

// ─── HTTP Proxy: Browser View ─────────────────────────────────────────────────
// GET /api/sessions/:id/browser?token=xxx
// Fetches debug HTML from container, rewrites the embedded wsUrl, and returns it.

export async function handleBrowserProxy(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;

  if (!token) return reply.status(401).send({ error: "Missing token" });

  const payload = await validateSessionToken(token);
  if (!payload || payload.sessionId !== sessionId) {
    return reply.status(401).send({ error: "Invalid token" });
  }

  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      userId: payload.userId,
      deletedAt: null,
      status: "running",
    },
  });
  if (!session?.internalApiUrl) {
    return reply.status(404).send({ error: "Session not found or not running" });
  }

  const debugUrl = `${session.internalApiUrl}/v1/sessions/debug`;
  let html: string;
  try {
    const res = await fetch(debugUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Upstream returned ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error("Failed to fetch debug view:", err);
    return reply.status(502).send({ error: "Failed to reach browser session" });
  }

  // Rewrite the internal wsUrl to go through our WebSocket proxy
  const containerName = `steelyard-session-${sessionId}`;
  const internalWsUrl = `ws://${containerName}:3000/v1/sessions/cast`;
  const host = request.headers.host ?? "localhost";
  const publicWsUrl = `ws://${host}/ws/sessions/${sessionId}/cast?token=${token}`;

  html = html.replace(
    `const baseWsUrl = '${internalWsUrl}'`,
    `const baseWsUrl = '${publicWsUrl}'`
  );

  // Update last active timestamp (fire-and-forget)
  prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});

  return reply
    .header("Content-Type", "text/html; charset=utf-8")
    .header("X-Frame-Options", "SAMEORIGIN")
    .send(html);
}

// ─── HTTP Proxy: Session Details ─────────────────────────────────────────────
// GET /api/sessions/:id/details?token=xxx
// Fetches live session metadata from the Steel Browser container.

export async function handleDetailsProxy(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });

  const payload = await validateSessionToken(token);
  if (!payload || payload.sessionId !== sessionId) {
    return reply.status(401).send({ error: "Invalid token" });
  }

  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId: payload.userId, deletedAt: null, status: "running" },
  });
  if (!session?.internalApiUrl) {
    return reply.status(404).send({ error: "Session not found or not running" });
  }

  try {
    const res = await fetch(`${session.internalApiUrl}/v1/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = await res.json() as unknown;
    // Each container hosts exactly one Steel Browser session; return first entry.
    const sessions = Array.isArray(data) ? data : ((data as { sessions?: unknown[] })?.sessions ?? []);
    return reply.send(sessions[0] ?? {});
  } catch (err) {
    console.error("Failed to fetch session details:", err);
    return reply.status(502).send({ error: "Failed to reach browser session" });
  }
}

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────
// Handles the HTTP upgrade event from Fastify's underlying server.
// Matches: /ws/sessions/:id/(cast|logs)?token=xxx

const WS_PATH_REGEX = /^\/ws\/sessions\/([^/?]+)\/(cast|logs)/;

export async function handleWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) {
  const url = request.url ?? "";
  const match = url.match(WS_PATH_REGEX);
  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const wsType = match[2] as "cast" | "logs";
  // The session player appends params with "?" even when baseWsUrl already
  // has "?token=...", producing double-"?" URLs like "...cast?token=X?pageId=Y".
  // Merge all "?"-separated segments into a valid query string before parsing.
  const qs = new URLSearchParams(url.split("?").slice(1).join("&"));
  const token = qs.get("token");

  if (!token) {
    socket.destroy();
    return;
  }

  const payload = await validateSessionToken(token);
  if (!payload || payload.sessionId !== sessionId) {
    socket.destroy();
    return;
  }

  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      userId: payload.userId,
      deletedAt: null,
      status: "running",
    },
  });

  if (!session?.internalApiUrl) {
    socket.destroy();
    return;
  }

  // Rewrite path based on WebSocket type
  if (wsType === "logs") {
    request.url = "/v1/sessions/logs";
  } else {
    // cast: rewrite /ws/sessions/{id}/cast → /v1/sessions/cast, preserve player params
    request.url = "/v1/sessions/cast";
    const pageId = qs.get("pageId");
    const pageIndex = qs.get("pageIndex");
    const tabInfo = qs.get("tabInfo");
    const innerQs = new URLSearchParams();
    if (pageId) innerQs.set("pageId", pageId);
    if (pageIndex) innerQs.set("pageIndex", pageIndex);
    if (tabInfo) innerQs.set("tabInfo", tabInfo);
    const innerQsStr = innerQs.toString();
    if (innerQsStr) request.url += `?${innerQsStr}`;
  }

  // Update last active timestamp (fire-and-forget)
  prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});

  proxyServer.ws(request, socket, head, { target: session.internalApiUrl });
}
