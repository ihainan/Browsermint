import { IncomingMessage, ServerResponse } from "http";
import { Duplex } from "stream";
import net from "net";
import httpProxy from "http-proxy";
import jwt from "jsonwebtoken";
import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { executeCdpCommand } from "./cdp.service.js";

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

interface ResolvedDevtoolsTarget {
  pageId: string | null;
  wsPath: string | null;
}

// ─── Proxy Server (singleton) ─────────────────────────────────────────────────

export const proxyServer = httpProxy.createProxyServer({});

proxyServer.on("error", (err, _req, res) => {
  console.error("[proxy] Proxy error:", err.message);
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
  const forwardedProto = getFirstHeaderValue(request.headers["x-forwarded-proto"]);
  let isHttps = forwardedProto === "https";

  if (!forwardedProto) {
    for (const headerName of ["origin", "referer"] as const) {
      const headerValue = getFirstHeaderValue(request.headers[headerName]);
      if (!headerValue) continue;

      try {
        isHttps = new URL(headerValue).protocol === "https:";
        break;
      } catch {
        continue;
      }
    }
  }

  return {
    http: isHttps ? "https" : "http",
    ws: isHttps ? "wss" : "ws",
  };
}

function getFirstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value !== "string") return null;
  return value.split(",")[0]?.trim() || null;
}

function getPublicRequestHost(
  request: Pick<FastifyRequest, "headers"> | IncomingMessage
): string {
  const forwardedHost = getFirstHeaderValue(request.headers["x-forwarded-host"]);
  if (forwardedHost) return forwardedHost;

  for (const headerName of ["origin", "referer"] as const) {
    const headerValue = getFirstHeaderValue(request.headers[headerName]);
    if (!headerValue) continue;

    try {
      return new URL(headerValue).host;
    } catch {
      continue;
    }
  }

  return getFirstHeaderValue(request.headers.host) ?? "localhost";
}

function rewriteUpstreamWebSocketUrl(
  request: Pick<FastifyRequest, "headers"> | IncomingMessage,
  sessionId: string,
  token: string,
  rawWsUrl: string
): string | null {
  try {
    const upstreamWsUrl = new URL(rawWsUrl);
    const host = getPublicRequestHost(request);
    const { ws: wsProto } = getRequestProtocols(request);
    return `${wsProto}://${host}/ws/sessions/${sessionId}/cdp${upstreamWsUrl.pathname}?token=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
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

async function resolveDevtoolsTarget(
  session: { internalApiUrl: string | null },
  pageId?: string | null
): Promise<ResolvedDevtoolsTarget> {
  if (!session.internalApiUrl) {
    return { pageId: null, wsPath: null };
  }

  const inspectorUrl = new URL("/v1/devtools/inspector.html", session.internalApiUrl);
  if (pageId) inspectorUrl.searchParams.set("pageId", pageId);

  const res = await fetch(inspectorUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  const redirectLocation = res.headers.get("location");
  if (!redirectLocation) {
    return { pageId: null, wsPath: null };
  }

  const target = new URL(redirectLocation, getDevtoolsBaseUrl(session.internalApiUrl));
  const rawWs = target.searchParams.get("ws");
  if (!rawWs) {
    return { pageId: null, wsPath: null };
  }

  const wsTarget = new URL(`http:${rawWs}`);
  const pageIdMatch = wsTarget.pathname.match(/\/devtools\/page\/([^/?]+)/);

  return {
    pageId: pageIdMatch ? decodeURIComponent(pageIdMatch[1]) : null,
    wsPath: wsTarget.pathname,
  };
}

async function updateLastActiveAt(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});
}

function logSessionEvent(
  sessionId: string,
  operationType: string,
  sourceIp: string | null,
  requestPath: string | null,
  statusCode?: number,
  metadata?: Record<string, string | number | boolean | null>
) {
  prisma.sessionEvent.create({
    data: {
      sessionId,
      operationType,
      sourceIp,
      requestPath,
      statusCode: statusCode ?? null,
      metadata: metadata ?? undefined,
    },
  }).catch(() => {});
}

function getIncomingMessageIp(request: IncomingMessage): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first?.trim() ?? null;
  }
  return request.socket?.remoteAddress ?? null;
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
    console.error(`[browser-proxy] Failed to fetch debug view for session ${sessionId}:`, err);
    return reply.status(502).send({ error: "Failed to reach browser session" });
  }

  // Rewrite the embedded session player WebSocket to go through our proxy.
  // The upstream may render either a container hostname or an internal IP, so
  // replace the assigned constant instead of matching one exact origin.
  const host = getPublicRequestHost(request);
  const { ws: wsProto } = getRequestProtocols(request);
  const publicWsUrl = `${wsProto}://${host}/ws/sessions/${sessionId}/cast?token=${token}`;

  html = html.replace(
    /const\s+baseWsUrl\s*=\s*['"][^'"]+['"];/,
    `const baseWsUrl = '${publicWsUrl}';`
  );

  // Inject macOS keyboard remapper: forwards Cmd+key as Ctrl+key to the remote Linux browser
  const keyboardScript = `<script>(function(){var _r=false;function remap(e){if(_r||!e.metaKey||e.ctrlKey)return;_r=true;e.preventDefault();e.stopImmediatePropagation();(e.target||document).dispatchEvent(new e.constructor(e.type,{bubbles:e.bubbles,cancelable:e.cancelable,composed:e.composed,view:e.view||window,ctrlKey:true,metaKey:false,shiftKey:e.shiftKey,altKey:e.altKey,key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,charCode:e.charCode||0,repeat:e.repeat}));_r=false;}document.addEventListener('keydown',remap,true);document.addEventListener('keyup',remap,true);})();</script>`;
  if (html.includes('</head>')) {
    html = html.replace('</head>', keyboardScript + '</head>');
  } else {
    html = keyboardScript + html;
  }

  // Update last active timestamp and log event (fire-and-forget)
  await updateLastActiveAt(sessionId);
  logSessionEvent(sessionId, "browser_view", request.ip, request.url, 200);

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

    // Rewrite websocketUrl to the browser-level Chrome CDP endpoint so external
    // agents (Playwright, Puppeteer, etc.) can connect directly via CDP.
    // Steel Browser's own websocketUrl points to port 3000 (its internal proxy),
    // not a valid Chrome CDP path. We fetch /json/version from the CDP port (9223)
    // to get the real browser WebSocket path (/devtools/browser/{id}), then
    // rewrite it through our /cdp proxy — which already handles this path correctly.
    try {
      const cdpBaseUrl = getDevtoolsBaseUrl(session.internalApiUrl!);
      const versionRes = await fetch(new URL("/json/version", cdpBaseUrl), {
        signal: AbortSignal.timeout(3000),
      });
      if (versionRes.ok) {
        const versionData = await versionRes.json() as { webSocketDebuggerUrl?: string };
        if (typeof versionData.webSocketDebuggerUrl === "string") {
          const publicWebsocketUrl = rewriteUpstreamWebSocketUrl(
            request,
            sessionId,
            token,
            versionData.webSocketDebuggerUrl
          );
          if (publicWebsocketUrl) {
            sessionDetail.websocketUrl = publicWebsocketUrl;
          }
        }
      }
    } catch {
      // Non-fatal: keep whatever websocketUrl Steel Browser returned
    }

    // Reflect SteelYard's own capsolver state rather than Steel Browser's value,
    // since SteelYard handles captcha solving independently via CDP injection.
    sessionDetail.solveCaptcha = Boolean(config.CAPSOLVER_API_KEY);

    if (token) {
      const host = getPublicRequestHost(request);
      const proto = getRequestProtocols(request).http;
      sessionDetail.debuggerUrl = `${proto}://${host}/api/sessions/${sessionId}/devtools/devtools_app.html?token=${encodeURIComponent(token)}`;

      const decoded = jwt.decode(token) as { exp?: number } | null;
      if (decoded?.exp) {
        sessionDetail.tokenExpiresAt = new Date(decoded.exp * 1000).toISOString();
      }
    }

    logSessionEvent(sessionId, "session_details", request.ip, request.url, 200);
    return reply.send(sessionDetail);
  } catch (err) {
    console.error(`[details-proxy] Failed to fetch session details for session ${sessionId}:`, err);
    return reply.status(502).send({ error: "Failed to reach browser session" });
  }
}

// ─── HTTP Proxy: DevTools Frontend ───────────────────────────────────────────
// GET /api/sessions/:id/devtools/*?token=xxx
// Proxies Chrome DevTools frontend assets and rewrites the page websocket target.

export async function handleDevtoolsProxy(
  request: FastifyRequest<{ Params: { id: string; "*": string }; Querystring: { token?: string; pageId?: string } }>,
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
      const host = getPublicRequestHost(request);
      const pageId = typeof request.query.pageId === "string" ? request.query.pageId : null;
      const resolvedTarget = await resolveDevtoolsTarget(session, pageId);

      if (resolvedTarget.wsPath) {
        upstreamUrl.searchParams.set(
          "ws",
          `//${host}/ws/sessions/${sessionId}/cdp${resolvedTarget.wsPath}?token=${token}`
        );
      }
    } catch (err) {
      console.error(`[devtools-proxy] Failed to resolve DevTools target for session ${sessionId}:`, err);
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
    if (assetPath === "devtools_app.html") {
      logSessionEvent(sessionId, "devtools", request.ip, request.url, 200);
    }

    const body = Buffer.from(await res.arrayBuffer());
    return reply.send(body);
  } catch (err) {
    console.error(`[devtools-proxy] Failed to fetch asset "${assetPath}" for session ${sessionId}:`, err);
    return reply.status(502).send({ error: "Failed to reach DevTools frontend" });
  }
}

export async function handleDevtoolsTargetProxy(
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

  try {
    const target = await resolveDevtoolsTarget(context.session);
    return reply.send(target);
  } catch (err) {
    console.error(`[devtools-proxy] Failed to resolve DevTools target for session ${sessionId}:`, err);
    return reply.status(502).send({ error: "Failed to resolve DevTools target" });
  }
}

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────
// Handles the HTTP upgrade event from Fastify's underlying server.
// Matches: /ws/sessions/:id/(cast|logs|pageId|cdp[/subpath])?token=xxx

const WS_PATH_REGEX = /^\/ws\/sessions\/([^/?]+)\/(cast|logs|pageId|cdp)(\/[^?]*)?/;

export async function handleWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) {
  const url = request.url ?? "";
  const match = url.match(WS_PATH_REGEX);
  if (!match) {
    console.warn("[ws-proxy] rejecting upgrade: path did not match", { url });
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const wsType = match[2] as "cast" | "logs" | "pageId" | "cdp";
  const wsSubPath = match[3] ?? "/";
  // The session player appends params with "?" even when baseWsUrl already
  // has "?token=...", producing double-"?" URLs like "...cast?token=X?pageId=Y".
  // Merge all "?"-separated segments into a valid query string before parsing.
  const qs = new URLSearchParams(url.split("?").slice(1).join("&"));
  const token = qs.get("token");

  if (!token) {
    console.warn("[ws-proxy] rejecting upgrade: missing token", {
      sessionId,
      wsType,
      url,
    });
    socket.destroy();
    return;
  }

  const payload = await validateSessionToken(token);
  if (!payload || payload.sessionId !== sessionId) {
    console.warn("[ws-proxy] rejecting upgrade: invalid token", {
      sessionId,
      wsType,
      payloadSessionId: payload?.sessionId ?? null,
      payloadUserId: payload?.userId ?? null,
    });
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
    console.warn("[ws-proxy] rejecting upgrade: session unavailable", {
      sessionId,
      wsType,
      userId: payload.userId,
    });
    socket.destroy();
    return;
  }

  // Rewrite path based on WebSocket type
  let proxyTarget = session.internalApiUrl;
  if (wsType === "logs") {
    request.url = "/v1/sessions/logs";
  } else if (wsType === "pageId") {
    request.url = "/v1/sessions/pageId";
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

  // Update last active timestamp and log event (fire-and-forget)
  prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});
  logSessionEvent(sessionId, `ws_${wsType}`, getIncomingMessageIp(request), url, 101);

  proxyServer.ws(request, socket, head, { target: proxyTarget });
}

// ─── CDP Tab Management ───────────────────────────────────────────────────────

interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

export async function handleGetTargets(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  try {
    const result = await executeCdpCommand(sessionId, "Target.getTargets", {});
    const targets = ((result.targetInfos ?? []) as CdpTarget[]).filter(
      (t) => t.type === "page"
    );
    logSessionEvent(sessionId, "targets_list", request.ip, request.url, 200);
    return reply.send({ targets });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleCreateTarget(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { url?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const url = (request.body as { url?: string })?.url ?? "chrome://newtab/";
  try {
    const result = await executeCdpCommand(sessionId, "Target.createTarget", { url });
    logSessionEvent(sessionId, "targets_create", request.ip, request.url, 200, { url });
    return reply.send({ targetId: result.targetId });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleCloseTarget(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  try {
    await executeCdpCommand(sessionId, "Target.closeTarget", { targetId });
    logSessionEvent(sessionId, "targets_close", request.ip, request.url, 200, { targetId });
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleActivateTarget(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  try {
    await executeCdpCommand(sessionId, "Target.activateTarget", { targetId });
    logSessionEvent(sessionId, "targets_activate", request.ip, request.url, 200, { targetId });
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleNavigate(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { url: string; targetId: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { url, targetId } = request.body as { url: string; targetId: string };
  if (!url || !targetId) return reply.status(400).send({ error: "url and targetId required" });

  try {
    const result = await executeCdpCommand(sessionId, "Page.navigate", { url }, targetId);
    logSessionEvent(sessionId, "navigate", request.ip, request.url, 200, { url, targetId });
    return reply.send(result);
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleGoBack(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { targetId: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { targetId } = request.body as { targetId: string };
  try {
    await executeCdpCommand(sessionId, "Page.goBack", {}, targetId);
    logSessionEvent(sessionId, "go_back", request.ip, request.url, 200, { targetId });
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleGoForward(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { targetId: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { targetId } = request.body as { targetId: string };
  try {
    await executeCdpCommand(sessionId, "Page.goForward", {}, targetId);
    logSessionEvent(sessionId, "go_forward", request.ip, request.url, 200, { targetId });
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleReload(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { targetId: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { targetId } = request.body as { targetId: string };
  try {
    await executeCdpCommand(sessionId, "Page.reload", {}, targetId);
    logSessionEvent(sessionId, "reload", request.ip, request.url, 200, { targetId });
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}
