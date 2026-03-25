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

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────
// Handles the HTTP upgrade event from Fastify's underlying server.
// Matches: /ws/sessions/:id/cast?token=xxx

const WS_PATH_REGEX = /^\/ws\/sessions\/([^/?]+)\/cast/;

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
  const qs = new URLSearchParams(url.split("?")[1] ?? "");
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

  // Rewrite path: /ws/sessions/{id}/cast → /v1/sessions/cast
  request.url = "/v1/sessions/cast";
  // Preserve pageId/pageIndex query params if present
  const pageId = qs.get("pageId");
  const pageIndex = qs.get("pageIndex");
  const tabInfo = qs.get("tabInfo");
  const innerQs = new URLSearchParams();
  if (pageId) innerQs.set("pageId", pageId);
  if (pageIndex) innerQs.set("pageIndex", pageIndex);
  if (tabInfo) innerQs.set("tabInfo", tabInfo);
  const innerQsStr = innerQs.toString();
  if (innerQsStr) request.url += `?${innerQsStr}`;

  // Update last active timestamp (fire-and-forget)
  prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});

  proxyServer.ws(request, socket, head, { target: session.internalApiUrl });
}
