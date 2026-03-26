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

interface SessionProxyContext {
  userId: string;
  sessionId: string;
  session: {
    id: string;
    containerName: string | null;
    internalApiUrl: string | null;
  };
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

async function getSessionProxyContext(
  sessionId: string,
  token: string
): Promise<SessionProxyContext | null> {
  const payload = await validateSessionToken(token);
  if (!payload || payload.sessionId !== sessionId) return null;

  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      userId: payload.userId,
      deletedAt: null,
      status: "running",
    },
    select: {
      id: true,
      containerName: true,
      internalApiUrl: true,
    },
  });

  if (!session?.internalApiUrl) return null;

  return { userId: payload.userId, sessionId, session };
}

function getRequestProtocols(request: Pick<FastifyRequest, "headers"> | IncomingMessage) {
  const isHttps = (request.headers["x-forwarded-proto"] as string | undefined) === "https";
  return {
    http: isHttps ? "https" : "http",
    ws: isHttps ? "wss" : "ws",
  };
}

function getDevtoolsBaseUrl(internalApiUrl: string): URL {
  const devtoolsUrl = new URL(internalApiUrl);
  devtoolsUrl.port = "9223";
  devtoolsUrl.pathname = "/";
  devtoolsUrl.search = "";
  devtoolsUrl.hash = "";
  return devtoolsUrl;
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      return rest.join("=") || null;
    }
  }
  return null;
}

async function updateLastActiveAt(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});
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

  const context = await getSessionProxyContext(sessionId, token);
  if (!context) {
    return reply.status(401).send({ error: "Invalid token" });
  }
  const { session } = context;

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
  await updateLastActiveAt(sessionId);

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

  const context = await getSessionProxyContext(sessionId, token);
  if (!context) {
    return reply.status(401).send({ error: "Invalid token" });
  }
  const { session } = context;

  try {
    const res = await fetch(`${session.internalApiUrl}/v1/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = await res.json() as unknown;
    // Each container hosts exactly one Steel Browser session; return first entry.
    const sessions = Array.isArray(data) ? data : ((data as { sessions?: unknown[] })?.sessions ?? []);
    const sessionDetail = (sessions[0] ?? {}) as Record<string, unknown>;

    // Rewrite the internal Docker websocketUrl to a publicly accessible proxy URL
    if (sessionDetail.websocketUrl) {
      const host = request.headers.host ?? "localhost";
      const proto = getRequestProtocols(request).ws;
      sessionDetail.websocketUrl = `${proto}://${host}/ws/sessions/${sessionId}/cdp`;
    }

    if (token) {
      const host = request.headers.host ?? "localhost";
      const proto = getRequestProtocols(request).http;
      sessionDetail.debuggerUrl = `${proto}://${host}/api/sessions/${sessionId}/devtools/devtools_app.html?token=${encodeURIComponent(token)}`;
    }

    return reply.send(sessionDetail);
  } catch (err) {
    console.error("Failed to fetch session details:", err);
    return reply.status(502).send({ error: "Failed to reach browser session" });
  }
}

// ─── HTTP Proxy: DevTools Frontend ───────────────────────────────────────────
// GET /api/sessions/:id/devtools/*?token=xxx
// Proxies Chrome DevTools frontend assets and rewrites the page websocket target.

export async function handleDevtoolsProxy(
  request: FastifyRequest<{ Params: { id: string; "*": string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token =
    request.query.token ??
    getCookieValue(request.headers.cookie, `steelyard_devtools_${sessionId}`);
  const assetPath = request.params["*"] || "devtools_app.html";

  if (!token) {
    return reply.status(401).send({ error: "Missing token" });
  }

  const context = await getSessionProxyContext(sessionId, token);
  if (!context) {
    return reply.status(401).send({ error: "Invalid token" });
  }
  const { session } = context;

  const devtoolsBaseUrl = getDevtoolsBaseUrl(session.internalApiUrl!);
  const upstreamUrl = new URL(assetPath, new URL("/devtools/", devtoolsBaseUrl));

  for (const [key, value] of Object.entries(request.query as Record<string, string | string[]>)) {
    if (Array.isArray(value)) {
      value.forEach((item) => upstreamUrl.searchParams.append(key, item));
    } else if (value !== undefined) {
      upstreamUrl.searchParams.set(key, value);
    }
  }

  if (assetPath === "devtools_app.html" && !upstreamUrl.searchParams.has("ws")) {
    try {
      const host = request.headers.host ?? "localhost";
      const pageId = typeof request.query.pageId === "string" ? request.query.pageId : null;

      if (pageId) {
        upstreamUrl.searchParams.set(
          "ws",
          `//${host}/ws/sessions/${sessionId}/cdp/devtools/page/${encodeURIComponent(pageId)}?token=${token}`
        );
      } else {
        const res = await fetch(`${session.internalApiUrl}/v1/devtools/inspector.html`, {
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        const redirectLocation = res.headers.get("location");
        if (redirectLocation) {
          const target = new URL(redirectLocation);
          const rawWs = target.searchParams.get("ws");
          if (rawWs) {
            const wsTarget = new URL(`http:${rawWs}`);
            upstreamUrl.searchParams.set(
              "ws",
              `//${host}/ws/sessions/${sessionId}/cdp${wsTarget.pathname}?token=${token}`
            );
          }
        }
      }
    } catch (err) {
      console.error("Failed to resolve DevTools target:", err);
    }
  }

  try {
    const res = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);

    const contentType = res.headers.get("content-type");
    if (contentType) reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Set-Cookie",
      `steelyard_devtools_${sessionId}=${encodeURIComponent(token)}; Path=/api/sessions/${sessionId}/devtools/; HttpOnly; SameSite=Lax`
    );

    await updateLastActiveAt(sessionId);

    const body = Buffer.from(await res.arrayBuffer());
    return reply.send(body);
  } catch (err) {
    console.error("Failed to fetch DevTools asset:", err);
    return reply.status(502).send({ error: "Failed to reach DevTools frontend" });
  }
}

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────
// Handles the HTTP upgrade event from Fastify's underlying server.
// Matches: /ws/sessions/:id/(cast|logs|cdp[/subpath])?token=xxx

const WS_PATH_REGEX = /^\/ws\/sessions\/([^/?]+)\/(cast|logs|cdp)(\/[^?]*)?/;

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
  const wsType = match[2] as "cast" | "logs" | "cdp";
  const wsSubPath = match[3] ?? "/";
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
  let proxyTarget = session.internalApiUrl;
  if (wsType === "logs") {
    request.url = "/v1/sessions/logs";
  } else if (wsType === "cdp") {
    // Forward directly to the container's CDP server (port 9223) at the given sub-path.
    // /ws/sessions/{id}/cdp        → /
    // /ws/sessions/{id}/cdp/devtools/page/{id} → /devtools/page/{id}
    request.url = wsSubPath;
    proxyTarget = getDevtoolsBaseUrl(session.internalApiUrl!).origin;
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

  proxyServer.ws(request, socket, head, { target: proxyTarget });
}
