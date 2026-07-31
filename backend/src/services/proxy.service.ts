import { IncomingMessage, ServerResponse } from "http";
import { Duplex } from "stream";
import net from "net";
import httpProxy from "http-proxy";
import WebSocket, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { acquireLease, renewLease, releaseLease, currentLease, isLockedByOther, LEASE_RENEW_HINT_MS } from "./lease.service.js";
import { executeCdpCommand, initCdpSession, cleanupCdpSession, closeBrowserGracefully, getOpenPageUrls, getOpenPageEntries, openSavedTabs, restoreSavedTabs, setTargetViewport, reapplyTargetViewport, attachCastViewer, COMBINED_INJECT_SCRIPT } from "./cdp.service.js";
import { solveCaptcha, type CaptchaType } from "./capsolver.service.js";
import { driver } from "./driver/index.js";
import { Prisma } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionTokenPayload {
  sub: string;
  sessionId: string;
  type: string;
  iat: number;
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

type ProxyServiceOverrides = Partial<{
  getDevtoolsBaseUrl: (internalApiUrl: string) => URL;
}>;

let proxyServiceOverrides: ProxyServiceOverrides = {};

export function setProxyServiceOverridesForTests(overrides: ProxyServiceOverrides): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setProxyServiceOverridesForTests can only be used when NODE_ENV=test");
  }
  proxyServiceOverrides = overrides;
}

export function resetProxyServiceOverridesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetProxyServiceOverridesForTests can only be used when NODE_ENV=test");
  }
  proxyServiceOverrides = {};
}

// ─── Proxy Server (singleton) ─────────────────────────────────────────────────

export const proxyServer = httpProxy.createProxyServer({});

// ─── Idle-pause tracking ──────────────────────────────────────────────────────

const wsConnectionCount = new Map<string, number>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const unpausingSession = new Set<string>();

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
): Promise<{ userId: string; sessionId: string; iat: number } | null> {
  try {
    const payload = jwt.verify(
      token,
      config.JWT_SESSION_TOKEN_SECRET
    ) as SessionTokenPayload;
    if (payload.type !== "session") return null;
    return { userId: payload.sub, sessionId: payload.sessionId, iat: payload.iat };
  } catch {
    return null;
  }
}

async function getSessionProxyContext(
  sessionId: string,
  token: string,
  opts?: { wake?: boolean }
): Promise<SessionProxyContext | null> {
  const payload = await validateSessionToken(token);
  if (!payload || payload.sessionId !== sessionId) return null;

  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      userId: payload.userId,
      user: { isActive: true },
      deletedAt: null,
      status: { in: ["running", "paused"] },
    },
    select: {
      id: true,
      containerName: true,
      internalApiUrl: true,
      tokenIssuedAt: true,
    },
  });

  if (!session?.internalApiUrl) return null;

  // Reject tokens issued before the last refresh (revocation check).
  if (session.tokenIssuedAt && payload.iat * 1000 < session.tokenIssuedAt.getTime()) {
    console.warn("[ws-proxy] rejecting upgrade: token has been superseded", { sessionId });
    return null;
  }

  // Driving endpoints (navigate/targets/clipboard/…) auto-resume a paused
  // session so REST-only clients work without opening a WebSocket first.
  // Read-only endpoints (details/devtools/vnc page) leave paused sessions
  // alone — the frontend polls those and must not defeat idle-pause.
  if (opts?.wake) {
    const freshUrl = await ensureSessionRunning(sessionId);
    if (!freshUrl) return null;
    session.internalApiUrl = freshUrl;
  }

  return { userId: payload.userId, sessionId, session };
}

export function getRequestProtocols(request: Pick<FastifyRequest, "headers"> | IncomingMessage) {
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

export function rewriteUpstreamWebSocketUrl(
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
  if (proxyServiceOverrides.getDevtoolsBaseUrl) {
    return proxyServiceOverrides.getDevtoolsBaseUrl(internalApiUrl);
  }
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

interface CdpListTarget {
  id: string;
  type: string;
  webSocketDebuggerUrl: string;
}

async function resolveDevtoolsTarget(
  session: { internalApiUrl: string | null },
  pageId?: string | null
): Promise<ResolvedDevtoolsTarget> {
  if (!session.internalApiUrl) {
    return { pageId: null, wsPath: null };
  }

  // Query Chrome's CDP /json/list directly (port 9223) to get live, up-to-date targets.
  // Steel Browser's /v1/devtools/inspector.html redirect caches the initial page ID and
  // becomes stale after navigation, causing "debugging connection was closed" in DevTools.
  const devtoolsBase = getDevtoolsBaseUrl(session.internalApiUrl);
  const listRes = await fetch(new URL("/json/list", devtoolsBase), {
    signal: AbortSignal.timeout(5000),
  });
  if (!listRes.ok) return { pageId: null, wsPath: null };

  const targets = await listRes.json() as CdpListTarget[];
  const pageTargets = targets.filter((t) => t.type === "page");

  // If a specific pageId was requested and it still exists, use it; otherwise fall
  // back to the first available page target.
  const chosen = pageId
    ? (pageTargets.find((t) => t.id === pageId) ?? pageTargets[0])
    : pageTargets[0];

  if (!chosen) return { pageId: null, wsPath: null };

  // webSocketDebuggerUrl may use any host (container name, IP, etc.) — extract only the path.
  const wsPathMatch = chosen.webSocketDebuggerUrl.match(/(\/devtools\/[^?]+)/);
  const wsPath = wsPathMatch ? wsPathMatch[1] : null;

  return { pageId: chosen.id, wsPath };
}

async function updateLastActiveAt(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});
}

/** Remove the `token` query parameter from a URL before storing it in the DB. */
export function sanitizeRequestPath(url: string): string {
  const firstQueryIndex = url.indexOf("?");
  const normalizedUrl = firstQueryIndex === -1
    ? url
    : url.slice(0, firstQueryIndex + 1) + url.slice(firstQueryIndex + 1).replace(/\?/g, "&");
  try {
    const u = new URL(normalizedUrl, "http://localhost");
    u.searchParams.delete("token");
    return u.pathname + (u.search || "");
  } catch {
    return normalizedUrl.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, "");
  }
}

function logSessionEvent(
  sessionId: string,
  operationType: string,
  sourceIp: string | null,
  requestPath: string | null,
  statusCode?: number,
  metadata?: Record<string, string | number | boolean | null>,
  source?: string
) {
  prisma.sessionEvent.create({
    data: {
      sessionId,
      operationType,
      sourceIp,
      requestPath: requestPath ? sanitizeRequestPath(requestPath).slice(0, 512) : null,
      statusCode: statusCode ?? null,
      metadata: metadata ?? undefined,
      source: source ?? null,
    },
  }).catch(() => {});
}

// Returns "frontend" if the HTTP request carries the Browsermint frontend marker,
// otherwise "agent". The frontend axios client sets X-Browsermint-Client: frontend
// on every request, which agents won't do.
export function getHttpSource(request: Pick<FastifyRequest, "headers"> | IncomingMessage): string {
  const header = request.headers["x-browsermint-client"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === "frontend" ? "frontend" : "agent";
}

// Returns "frontend" if the WebSocket upgrade originates from a browser page
// served by Browsermint (same-origin), otherwise "agent".
// Browsers automatically include an Origin header on WebSocket upgrades;
// non-browser clients (scripts, SDKs) typically omit it or send a different host.
export function getWebSocketSource(request: Pick<IncomingMessage, "headers">): string {
  const origin = request.headers["origin"];
  const host = request.headers["host"];
  if (!origin || !host) return "agent";
  try {
    return new URL(origin).host === host ? "frontend" : "agent";
  } catch {
    return "agent";
  }
}

export function getIncomingMessageIp(request: Pick<IncomingMessage, "headers" | "socket">): string | null {
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
  request: FastifyRequest<{
    Params: { id: string };
    Querystring: { token?: string; pageId?: string; interactive?: string; showControls?: string };
  }>,
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

  // Forward the viewer-shaping params to the upstream player. `pageId` puts it in
  // single-page mode (one CDP target, no tab bar) — that is what the platform's
  // right-hand "browser page" tab embeds; without forwarding, the upstream always
  // renders the full multi-tab chrome.
  const debugQs = new URLSearchParams();
  const pageId = typeof request.query.pageId === "string" ? request.query.pageId : "";
  if (pageId) debugQs.set("pageId", pageId);
  if (typeof request.query.interactive === "string") debugQs.set("interactive", request.query.interactive);
  if (typeof request.query.showControls === "string") debugQs.set("showControls", request.query.showControls);
  const debugQsStr = debugQs.toString();
  const debugUrl = `${session.internalApiUrl}/v1/sessions/debug${debugQsStr ? `?${debugQsStr}` : ""}`;
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
  const publicWsUrl = pageId
    ? `${wsProto}://${host}/ws/sessions/${sessionId}/cast?token=${token}&pageId=${encodeURIComponent(pageId)}`
    : `${wsProto}://${host}/ws/sessions/${sessionId}/cast?token=${token}`;

  html = html.replace(
    /const\s+baseWsUrl\s*=\s*['"][^'"]+['"];/,
    `const baseWsUrl = '${publicWsUrl}';`
  );

  // Inject macOS keyboard remapper: forwards Cmd+key as Ctrl+key to the remote Linux browser.
  // Skips remapping when the URL input is focused so native macOS shortcuts (Cmd+A/C/X/Z) work correctly.
  const keyboardScript = `<script>(function(){var _r=false;function remap(e){if(_r||!e.metaKey||e.ctrlKey)return;var u=document.getElementById('url-text');if(u&&document.activeElement===u)return;_r=true;e.preventDefault();e.stopImmediatePropagation();(e.target||document).dispatchEvent(new e.constructor(e.type,{bubbles:e.bubbles,cancelable:e.cancelable,composed:e.composed,view:e.view||window,ctrlKey:true,metaKey:false,shiftKey:e.shiftKey,altKey:e.altKey,key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,charCode:e.charCode||0,repeat:e.repeat}));_r=false;}document.addEventListener('keydown',remap,true);document.addEventListener('keyup',remap,true);})();</script>`;

  // Suppress the host browser's native context menu on the canvas and notify the parent
  // frame so it can show a custom context menu overlay instead.
  const contextMenuScript = `<script>document.addEventListener('contextmenu',function(e){if(e.target&&e.target.tagName==='CANVAS'){e.preventDefault();window.parent.postMessage({type:'showContextMenu',clientX:e.clientX,clientY:e.clientY},'*');}},true);</script>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', keyboardScript + contextMenuScript + '</head>');
  } else {
    html = keyboardScript + contextMenuScript + html;
  }

  // Update last active timestamp and log event (fire-and-forget)
  await updateLastActiveAt(sessionId);
  logSessionEvent(sessionId, "browser_view", request.ip, request.url, 200, undefined, "frontend");

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

    // Reflect Browsermint's own capsolver state rather than Steel Browser's value,
    // since Browsermint handles captcha solving independently via CDP injection.
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

    logSessionEvent(sessionId, "session_details", request.ip, request.url, 200, undefined, "frontend");
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
    getCookieValue(request.headers.cookie, `browsermint_devtools_${sessionId}`);
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
      `browsermint_devtools_${sessionId}=${encodeURIComponent(token)}; Path=/api/sessions/${sessionId}/devtools/; HttpOnly; SameSite=Lax`
    );

    await updateLastActiveAt(sessionId);
    if (assetPath === "devtools_app.html") {
      logSessionEvent(sessionId, "devtools", request.ip, request.url, 200, undefined, "frontend");
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

// ─── CDP Proxy Bridge ────────────────────────────────────────────────────────
//
// Replaces the raw http-proxy WebSocket pass-through for CDP connections.
// Unlike the raw proxy, the bridge inspects CDP messages so it can:
//
//   1. Detect when the agent creates a page session (Target.attachToTarget
//      response or Target.attachedToTarget event) and immediately register
//      Page.addScriptToEvaluateOnNewDocument in THAT session.
//      Because addScriptToEvaluateOnNewDocument is session-scoped in Chrome CDP,
//      scripts registered by the backend's own session do NOT fire when the
//      agent's separate session navigates. Registering in the agent's session
//      guarantees our stealth/captcha scripts run before any page JS on every
//      agent-triggered navigation.
//
//   2. Handle Runtime.bindingCalled for __browsermint_solve_captcha coming from
//      agent page sessions, so CapSolver works for agent-driven pages too.
//
//   3. Re-inject scripts on Page.frameNavigated as a timing backup (same logic
//      as the backend's own CDP session handler).
//
//   4. Filter responses to our internally-injected commands so the agent never
//      receives CDP response IDs it did not send.

// High offset for our injected command IDs so they never collide with the
// agent's own sequential IDs (agents typically start from 1).
const BRIDGE_CMD_OFFSET = 0x70000000;
let bridgeCmdCounter = 0;

// Commands that can change the page. During a user takeover these are refused
// for the leased target; reads (screenshot, DOM query, navigation history) still
// go through so the agent can observe rather than being told the browser broke.
//
// Runtime.evaluate counts as a write: it can do anything to the document.
const CDP_WRITE_PREFIXES = [
  "Input.", "Emulation.", "Storage.clear", "Browser.setWindowBounds",
];
const CDP_WRITE_METHODS = new Set([
  "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Page.close",
  "Page.setDeviceMetricsOverride", "Page.bringToFront", "Page.setDocumentContent",
  "Page.handleJavaScriptDialog", "Page.startScreencast", "Page.stopScreencast",
  "Runtime.evaluate", "Runtime.callFunctionOn", "Target.closeTarget",
  "Target.activateTarget", "DOM.setAttributeValue", "DOM.setOuterHTML",
  "DOM.focus", "DOM.setFileInputFiles",
]);

function isWriteCommand(method: string): boolean {
  if (CDP_WRITE_METHODS.has(method)) return true;
  return CDP_WRITE_PREFIXES.some((p) => method.startsWith(p));
}

function createCdpBridge(
  bsSessionId: string,
  socket: Duplex,
  head: Buffer,
  request: IncomingMessage,
  chromeWsUrl: string,
  onClose: () => void
): void {
  const wss = new WebSocketServer({ noServer: true });
  wss.handleUpgrade(request, socket, head, (agentWs) => {
    const chromeWs = new WebSocket(chromeWsUrl);
    let bridgeClosed = false;

    function closeBridge(): void {
      if (bridgeClosed) return;
      bridgeClosed = true;
      onClose();
      wss.close();
    }

    function closePeer(ws: WebSocket): void {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }

    // IDs of commands we injected — filter their responses from the agent.
    const ourCmdIds = new Set<number>();
    // Page sessions where we've already registered addScriptToEvaluateOnNewDocument.
    const injectedSessions = new Set<string>();
    // Agent's pending commands: id → method (to understand Chrome's responses).
    const pendingAgentCmds = new Map<number, string>();
    // Messages received from the agent before Chrome WS was open — drained on open.
    // Stored as { data, isBinary } to preserve the original WebSocket frame type.
    const pendingAgentMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

    function nextId(): number {
      const id = BRIDGE_CMD_OFFSET + bridgeCmdCounter++;
      ourCmdIds.add(id);
      return id;
    }

    function sendToChrome(msg: Record<string, unknown>): void {
      if (chromeWs.readyState === WebSocket.OPEN) {
        chromeWs.send(JSON.stringify(msg));
      }
    }

    function injectIntoSession(pgSessionId: string): void {
      if (injectedSessions.has(pgSessionId)) return;
      injectedSessions.add(pgSessionId);

      // Register our script to run before any page JS on every future navigation
      // in this session. This is the key fix: addScriptToEvaluateOnNewDocument
      // is session-scoped, so we must register it in the agent's own session.
      sendToChrome({
        id: nextId(), method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: COMBINED_INJECT_SCRIPT }, sessionId: pgSessionId,
      });

      if (config.CAPSOLVER_API_KEY) {
        // Register CDP binding so page JS can request captcha solving.
        sendToChrome({
          id: nextId(), method: "Runtime.addBinding",
          params: { name: "__browsermint_solve_captcha" }, sessionId: pgSessionId,
        });
        // Enable Page domain so we receive Page.frameNavigated for re-injection.
        sendToChrome({
          id: nextId(), method: "Page.enable",
          params: {}, sessionId: pgSessionId,
        });
      }

      // Also inject immediately into the already-loaded document.
      sendToChrome({
        id: nextId(), method: "Runtime.evaluate",
        params: { expression: COMBINED_INJECT_SCRIPT, returnByValue: false },
        sessionId: pgSessionId,
      });
    }

    const pendingAttachTargets = new Map<number, string>();
    const agentSessionTargets = new Map<string, string>();

    chromeWs.on("open", () => {
      // Drain any messages the agent sent before Chrome WS was ready.
      for (const { data, isBinary } of pendingAgentMessages) {
        chromeWs.send(data, { binary: isBinary });
      }
      pendingAgentMessages.length = 0;
    });

    const forwardToChrome = (data: WebSocket.RawData, isBinary: boolean) => {
      if (chromeWs.readyState === WebSocket.OPEN) {
        chromeWs.send(data, { binary: isBinary });
      } else {
        // Chrome WS not yet open — buffer and replay once it opens.
        pendingAgentMessages.push({ data, isBinary });
      }
    };

    agentWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      let msg: Record<string, unknown> | null = null;
      // Track agent's outgoing commands so we can interpret Chrome's responses.
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (typeof msg.id === "number" && typeof msg.method === "string") {
          pendingAgentCmds.set(msg.id, msg.method);
          // Remember which target each flat session belongs to, so a write can be
          // matched against the lease on *that* target rather than all of them.
          if (msg.method === "Target.attachToTarget") {
            const tid = (msg.params as Record<string, unknown> | undefined)?.targetId;
            if (typeof tid === "string") pendingAttachTargets.set(msg.id, tid);
          }
        }
      } catch { /* non-JSON is fine to forward as-is */ }

      const method = typeof msg?.method === "string" ? msg.method : null;
      const cdpSessionId = typeof msg?.sessionId === "string" ? msg.sessionId : null;
      const targetId = cdpSessionId ? agentSessionTargets.get(cdpSessionId) : undefined;

      if (method && isWriteCommand(method) && targetId) {
        // Arbitration point. The agent has its own token and could reach CDP
        // directly, so this — not the platform — is where a takeover is enforced.
        isLockedByOther(bsSessionId, targetId, null)
          .then((holder) => {
            if (!holder) return forwardToChrome(data, isBinary);
            if (typeof msg?.id === "number" && agentWs.readyState === WebSocket.OPEN) {
              agentWs.send(JSON.stringify({
                id: msg.id,
                error: {
                  code: -32000,
                  message: "browsermint: target is being controlled by a user; " +
                    "retry after the takeover ends (re-observe the page first)",
                },
              }));
            }
            logSessionEvent(bsSessionId, "agent_write_refused", "", method, 409,
              { targetId, holder: holder.holderLabel }, "cdp");
          })
          .catch(() => forwardToChrome(data, isBinary));   // 仲裁失败不阻断 agent
        return;
      }
      forwardToChrome(data, isBinary);
    });

    chromeWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      let forward = true;

      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

        // Filter responses to our own injected commands — the agent never
        // sent those IDs, so seeing the responses would confuse it.
        if (typeof msg.id === "number" && ourCmdIds.has(msg.id)) {
          ourCmdIds.delete(msg.id);
          forward = false;
        }

        // Detect page session created by the agent via Target.attachToTarget.
        if (typeof msg.id === "number" && pendingAgentCmds.has(msg.id) && !msg.error) {
          const method = pendingAgentCmds.get(msg.id)!;
          pendingAgentCmds.delete(msg.id);
          if (method === "Target.attachToTarget") {
            const pgSessionId = (msg.result as Record<string, unknown> | undefined)?.sessionId as string | undefined;
            if (pgSessionId) {
              injectIntoSession(pgSessionId);
              const tid = pendingAttachTargets.get(msg.id as number);
              if (tid) agentSessionTargets.set(pgSessionId, tid);
            }
          }
          pendingAttachTargets.delete(msg.id as number);
        }

        // Detect page sessions from auto-attach (if agent called Target.setAutoAttach).
        if (msg.method === "Target.attachedToTarget") {
          const p = msg.params as Record<string, unknown> | undefined;
          const pgSessionId = p?.sessionId as string | undefined;
          if (pgSessionId) {
            injectIntoSession(pgSessionId);
            const info = p?.targetInfo as Record<string, unknown> | undefined;
            if (typeof info?.targetId === "string") agentSessionTargets.set(pgSessionId, info.targetId);
          }
        }

        // Handle captcha solve requests from our injected script running in the
        // agent's page session. The backend's own CDP handler covers its sessions;
        // this covers sessions that belong to the proxy WebSocket connection.
        if (msg.method === "Runtime.bindingCalled" && config.CAPSOLVER_API_KEY) {
          const params = msg.params as Record<string, unknown> | undefined;
          const pgSessionId = msg.sessionId as string | undefined;
          if (
            params?.name === "__browsermint_solve_captcha" &&
            pgSessionId &&
            injectedSessions.has(pgSessionId)
          ) {
            let payload: { requestId: string; type?: string; siteKey: string; action?: string; url: string; enterprisePayload?: Record<string, string> } | undefined;
            try { payload = JSON.parse(params.payload as string); } catch { /* skip malformed */ }
            if (payload) {
              const captchaType = (payload.type ?? "recaptcha-enterprise") as CaptchaType;
              const { requestId, siteKey, url: captchaUrl, action, enterprisePayload } = payload;
              solveCaptcha(captchaType, siteKey, captchaUrl, action ?? "", config.CAPSOLVER_API_KEY, undefined, enterprisePayload)
                .then(({ token }) => {
                  const expr = `window.__browsermint_resolve_captcha(${JSON.stringify(requestId)},${JSON.stringify(token)})`;
                  sendToChrome({ id: nextId(), method: "Runtime.evaluate", params: { expression: expr }, sessionId: pgSessionId });
                  console.log(`[cdp-proxy] CapSolver: resolved ${captchaType} for session ${bsSessionId}`);
                })
                .catch((err: Error) => {
                  const expr = `window.__browsermint_reject_captcha(${JSON.stringify(requestId)},${JSON.stringify(err.message)})`;
                  sendToChrome({ id: nextId(), method: "Runtime.evaluate", params: { expression: expr }, sessionId: pgSessionId });
                  console.warn(`[cdp-proxy] CapSolver failed (${captchaType}) for session ${bsSessionId}:`, err.message);
                });
            }
          }
        }

        // Re-inject scripts after main-frame navigation as a timing backup.
        // addScriptToEvaluateOnNewDocument covers future navigations reliably, but
        // this catches the edge case where the page loads faster than the inject.
        if (msg.method === "Page.frameNavigated") {
          const frame = (msg.params as Record<string, unknown> | undefined)?.frame as Record<string, unknown> | undefined;
          const pgSessionId = msg.sessionId as string | undefined;
          if (!frame?.parentId && pgSessionId && injectedSessions.has(pgSessionId)) {
            if (config.CAPSOLVER_API_KEY) {
              sendToChrome({ id: nextId(), method: "Runtime.addBinding", params: { name: "__browsermint_solve_captcha" }, sessionId: pgSessionId });
            }
            sendToChrome({ id: nextId(), method: "Runtime.evaluate", params: { expression: COMBINED_INJECT_SCRIPT, returnByValue: false }, sessionId: pgSessionId });
          }
        }
      } catch { /* non-JSON or parse errors are forwarded as-is */ }

      if (forward && agentWs.readyState === WebSocket.OPEN) agentWs.send(data, { binary: isBinary });
    });

    agentWs.on("close", () => { closeBridge(); closePeer(chromeWs); });
    agentWs.on("error", () => { closeBridge(); closePeer(chromeWs); });
    chromeWs.on("close", () => { closeBridge(); closePeer(agentWs); });
    chromeWs.on("error", () => { closeBridge(); closePeer(agentWs); });
  });
}

// ─── Page labels (stable external page identity) ─────────────────────────────
// Embedders track pages by their own id; CDP target ids are recreated on every
// resume. These endpoints let them attach that id to a target and read back the
// mapping after a restore.

// PUT /api/sessions/:id/target-labels?token=xxx   { label, targetId }
export async function handleSetTargetLabel(
  request: FastifyRequest<{
    Params: { id: string }; Querystring: { token?: string };
    Body: { label?: string; targetId?: string };
  }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { label, targetId } = request.body ?? {};
  if (!label || !targetId) {
    return reply.status(400).send({ error: "label and targetId required" });
  }
  const row = await prisma.session.findUnique({
    where: { id: sessionId }, select: { targetLabels: true },
  });
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries((row?.targetLabels ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string") labels[k] = v;
  }
  labels[label] = targetId;
  await prisma.session.update({ where: { id: sessionId }, data: { targetLabels: labels } });
  return reply.send({ ok: true });
}

// GET /api/sessions/:id/target-labels?token=xxx
export async function handleGetTargetLabels(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const row = await prisma.session.findUnique({
    where: { id: sessionId }, select: { targetLabels: true },
  });
  return reply.send({ labels: (row?.targetLabels ?? {}) as Record<string, string> });
}

// ─── Idle-pause helpers ───────────────────────────────────────────────────────

export function clearIdleTimer(sessionId: string): void {
  cancelIdleTimer(sessionId);
  wsConnectionCount.delete(sessionId);
}

/** Cancel only the pending idle timer, keeping the live WS connection count. */
function cancelIdleTimer(sessionId: string): void {
  const timer = idleTimers.get(sessionId);
  if (timer) { clearTimeout(timer); idleTimers.delete(sessionId); }
}

export function hasIdleTimerForTests(sessionId: string): boolean {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("hasIdleTimerForTests can only be used when NODE_ENV=test");
  }
  return idleTimers.has(sessionId);
}

export function wsCountForTests(sessionId: string): number {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("wsCountForTests can only be used when NODE_ENV=test");
  }
  return wsConnectionCount.get(sessionId) ?? 0;
}

export function trackWsConnectionForTests(sessionId: string): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("trackWsConnectionForTests can only be used when NODE_ENV=test");
  }
  incrementWsCount(sessionId);
  return createWsRelease(sessionId);
}

export function scheduleIdlePauseOnStartup(sessionId: string): void {
  scheduleIdlePause(sessionId);
}

function incrementWsCount(sessionId: string): void {
  // Only cancel the pending idle timer — clearing the whole counter here would
  // wipe the connections opened by other viewers, so the *next* disconnect would
  // drop the count to 0 and idle-pause a session that is still being watched.
  cancelIdleTimer(sessionId);
  wsConnectionCount.set(sessionId, (wsConnectionCount.get(sessionId) ?? 0) + 1);
}

/**
 * One-shot connection release. "error" is normally followed by "close", so a
 * naive listener pair decrements twice and drives the shared counter below the
 * number of live viewers (which then idle-pauses a watched session).
 */
function createWsRelease(sessionId: string): () => void {
  let counted = true;
  return () => {
    if (!counted) return;
    counted = false;
    decrementWsCount(sessionId);
  };
}

function decrementWsCount(sessionId: string): void {
  const next = Math.max(0, (wsConnectionCount.get(sessionId) ?? 1) - 1);
  if (next === 0) {
    wsConnectionCount.delete(sessionId);
    scheduleIdlePause(sessionId);
  } else {
    wsConnectionCount.set(sessionId, next);
  }
}

function scheduleIdlePause(sessionId: string): void {
  if (!config.IDLE_PAUSE_ENABLED) return;
  if (idleTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    void pauseSessionIfIdle(sessionId);
  }, config.IDLE_PAUSE_TIMEOUT_MS);
  idleTimers.set(sessionId, timer);
}

async function pauseSessionIfIdle(sessionId: string): Promise<void> {
  if ((wsConnectionCount.get(sessionId) ?? 0) > 0) return;

  const session = await prisma.session.findFirst({
    where: { id: sessionId, status: "running", deletedAt: null },
    select: { containerId: true, runningStartedAt: true },
  });
  if (!session?.containerId) return;

  console.info(`[idle-pause] Session ${sessionId} idle — pausing`);
  try {
    // Pause-by-deletion drivers (K8s) lose the in-memory Chrome on pause: save
    // the open tabs for restore on resume, and close Chrome gracefully so the
    // profile (cookies etc.) is flushed to the PVC before the pod goes away.
    // Save pages **with the embedder's labels**: CDP target ids die with the pod,
    // so a plain URL list cannot tell which restored tab is which page when the
    // same URL appears twice or a redirect changes it.
    let savedTabs: Array<{ label?: string; url: string }> = [];
    if (driver.pauseReleasesWorkload) {
      const entries = await getOpenPageEntries(sessionId).catch(() => []);
      const labelRow = await prisma.session.findUnique({
        where: { id: sessionId }, select: { targetLabels: true },
      }).catch(() => null);
      const labelByTarget = new Map<string, string>();
      const stored = (labelRow?.targetLabels ?? {}) as Record<string, unknown>;
      for (const [label, targetId] of Object.entries(stored)) {
        if (typeof targetId === "string") labelByTarget.set(targetId, label);
      }
      savedTabs = entries.map((e: { targetId: string; url: string }) => ({ label: labelByTarget.get(e.targetId), url: e.url }));
      await closeBrowserGracefully(sessionId).catch(() => {});
    }
    cleanupCdpSession(sessionId);
    await driver.pauseSession(sessionId, session.containerId);
    const delta = session.runningStartedAt
      ? Math.max(0, Date.now() - session.runningStartedAt.getTime())
      : 0;
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: "paused",
        onlineMs: { increment: delta },
        runningStartedAt: null,
        ...(driver.pauseReleasesWorkload
          ? { savedTabs: savedTabs.length > 0 ? savedTabs : Prisma.JsonNull }
          : {}),
      },
    });
    console.info(`[idle-pause] Session ${sessionId} paused`);
  } catch (err) {
    console.error(`[idle-pause] Failed to pause session ${sessionId}:`, err);
  }
}

// ─── Auto-resume (shared by WS upgrade and driving REST endpoints) ──────────
// Resume a paused session, deduplicating concurrent attempts via
// unpausingSession. Returns the fresh internalApiUrl, or null when the
// session could not be brought to "running".
async function ensureSessionRunning(sessionId: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, deletedAt: null, status: { in: ["running", "paused"] } },
    select: { status: true, containerId: true, internalApiUrl: true },
  });
  if (!session) return null;
  if (session.status === "running") return session.internalApiUrl;
  if (!session.containerId) {
    console.warn("[resume] paused session has no containerId", { sessionId });
    return null;
  }

  if (unpausingSession.has(sessionId)) {
    // Another caller is already resuming — wait for it to finish
    const deadline = Date.now() + driver.resumeTimeoutMs;
    while (unpausingSession.has(sessionId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const refreshed = await prisma.session.findFirst({
      where: { id: sessionId, deletedAt: null },
      select: { status: true, internalApiUrl: true },
    });
    if (refreshed?.status !== "running" || !refreshed.internalApiUrl) {
      console.warn("[resume] session not running after waiting for concurrent resume", { sessionId });
      return null;
    }
    return refreshed.internalApiUrl;
  }

  unpausingSession.add(sessionId);
  try {
    console.info(`[resume] Resuming paused session ${sessionId}`);
    const endpoint = await driver.resumeSession(sessionId, session.containerId);
    await driver.waitForReady(endpoint.internalApiUrl);
    // Persist the endpoint: on Docker the IP is unchanged, but on K8s the
    // pod was recreated and the DB must reflect the fresh workload.
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: "running",
        containerId: endpoint.containerId,
        containerName: endpoint.containerName,
        internalApiUrl: endpoint.internalApiUrl,
        runningStartedAt: new Date(),
      },
    });
    if (!driver.pauseReleasesWorkload) {
      // docker unpause: Chrome thaws in place, give it a moment
      await new Promise((r) => setTimeout(r, 500));
      void initCdpSession(sessionId, endpoint.internalApiUrl).then((ok) => {
        if (!ok) console.warn(`[resume] CDP re-init failed after unpause for session ${sessionId}`);
      });
    } else {
      // Fresh Chrome in a new pod: re-attach CDP synchronously, then
      // restore the tabs saved by pauseSessionIfIdle.
      const ok = await initCdpSession(sessionId, endpoint.internalApiUrl);
      if (!ok) console.warn(`[resume] CDP re-init failed after resume for session ${sessionId}`);
      const current = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { savedTabs: true },
      });
      // Accept both shapes: legacy string[] (sessions paused before this change)
      // and the labelled [{label?, url}] written by pauseSessionIfIdle now.
      const rawTabs = Array.isArray(current?.savedTabs) ? (current.savedTabs as unknown[]) : [];
      const savedTabs = rawTabs
        .map(t => (typeof t === "string"
          ? { url: t }
          : (t && typeof (t as { url?: unknown }).url === "string"
            ? { label: (t as { label?: string }).label, url: (t as { url: string }).url }
            : null)))
        .filter((t): t is { label?: string; url: string } => t !== null);
      let restoredLabels: Record<string, string> = {};
      if (ok && savedTabs.length > 0) {
        console.info(`[resume] Session ${sessionId}: restoring ${savedTabs.length} saved tab(s)`);
        restoredLabels = await restoreSavedTabs(sessionId, savedTabs).catch(() => ({}));
      }
      await prisma.session.update({
        where: { id: sessionId },
        data: {
          savedTabs: Prisma.JsonNull,
          // Publish the new label→target mapping so embedders can rebind their
          // own page ids; empty object when nothing was labelled.
          targetLabels: restoredLabels,
        },
      }).catch(() => {});
    }
    // A session that was just driven should not immediately re-pause: restart
    // the idle timer (WS callers replace this via incrementWsCount anyway).
    scheduleIdlePause(sessionId);
    return endpoint.internalApiUrl;
  } catch (err) {
    console.error(`[resume] Failed to resume session ${sessionId}:`, err);
    await prisma.session.update({ where: { id: sessionId }, data: { status: "error" } }).catch(() => {});
    return null;
  } finally {
    unpausingSession.delete(sessionId);
  }
}

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────
// Handles the HTTP upgrade event from Fastify's underlying server.
// Matches: /ws/sessions/:id/(cast|logs|pageId|cdp[/subpath])?token=xxx

const WS_PATH_REGEX = /^\/ws\/sessions\/([^/?]+)\/(cast|pagecast|logs|pageId|cdp|vnc)(\/[^?]*)?/;

export type SessionWebSocketPath = {
  sessionId: string;
  wsType: "cast" | "pagecast" | "logs" | "pageId" | "cdp" | "vnc";
  wsSubPath: string;
  token: string | null;
};

export function parseSessionWebSocketPath(url: string): SessionWebSocketPath | null {
  const match = url.match(WS_PATH_REGEX);
  if (!match) return null;

  // The session player appends params with "?" even when baseWsUrl already
  // has "?token=...", producing double-"?" URLs like "...cast?token=X?pageId=Y".
  // Merge all "?"-separated segments into a valid query string before parsing.
  const qs = new URLSearchParams(url.split("?").slice(1).join("&"));
  return {
    sessionId: match[1],
    wsType: match[2] as SessionWebSocketPath["wsType"],
    wsSubPath: match[3] ?? "/",
    token: qs.get("token"),
  };
}

// One shared server for viewer sockets we terminate ourselves (noServer: the
// upgrade is handed to us by Fastify's http server).
const pagecastWss = new WebSocketServer({ noServer: true });

export async function handleWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) {
  const url = request.url ?? "";
  const parsedPath = parseSessionWebSocketPath(url);
  if (!parsedPath) {
    console.warn("[ws-proxy] rejecting upgrade: path did not match", { url });
    socket.destroy();
    return;
  }

  const { sessionId, wsType, wsSubPath, token } = parsedPath;
  const qs = new URLSearchParams(url.split("?").slice(1).join("&"));

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
      user: { isActive: true },
      deletedAt: null,
      status: { in: ["running", "paused"] },
    },
    select: {
      id: true,
      status: true,
      containerId: true,
      containerName: true,
      internalApiUrl: true,
      tokenIssuedAt: true,
    },
  });

  if (!session) {
    console.warn("[ws-proxy] rejecting upgrade: session unavailable", {
      sessionId,
      wsType,
      userId: payload.userId,
    });
    socket.destroy();
    return;
  }

  // Reject tokens that were issued before the last token refresh.
  if (session.tokenIssuedAt && payload.iat * 1000 < session.tokenIssuedAt.getTime()) {
    console.warn("[ws-proxy] rejecting upgrade: token has been superseded", { sessionId });
    socket.destroy();
    return;
  }

  // ─── Auto-resume if session is paused ────────────────────────────────────────
  if (session.status === "paused") {
    const freshUrl = await ensureSessionRunning(sessionId);
    if (!freshUrl) {
      console.warn("[ws-proxy] rejecting upgrade: session could not be resumed", { sessionId });
      socket.destroy();
      return;
    }
    session.status = "running";
    session.internalApiUrl = freshUrl;
  }

  if (!session.internalApiUrl) {
    console.warn("[ws-proxy] rejecting upgrade: no internalApiUrl after unpause", { sessionId });
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
    // CDP connections use the inspecting bridge (createCdpBridge) instead of
    // the raw proxy. The bridge detects page sessions created by the agent and
    // injects addScriptToEvaluateOnNewDocument into those sessions so our
    // stealth/captcha scripts fire before page JS on every navigation.
    //
    // Path resolution is the same as before:
    //   /ws/sessions/{id}/cdp              → auto-resolve browser UUID via /json/version
    //   /ws/sessions/{id}/cdp/devtools/... → direct sub-path
    const cdpBase = getDevtoolsBaseUrl(session.internalApiUrl!);
    let cdpPath: string;
    if (wsSubPath === "/" || wsSubPath === "") {
      try {
        const versionRes = await fetch(new URL("/json/version", cdpBase), {
          signal: AbortSignal.timeout(3000),
        });
        if (versionRes.ok) {
          const versionData = await versionRes.json() as { webSocketDebuggerUrl?: string };
          cdpPath = typeof versionData.webSocketDebuggerUrl === "string"
            ? new URL(versionData.webSocketDebuggerUrl).pathname
            : "/";
        } else {
          cdpPath = "/";
        }
      } catch {
        cdpPath = "/";
      }
    } else {
      cdpPath = wsSubPath;
    }

    // Update last active timestamp and log event (fire-and-forget)
    prisma.session.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() },
    }).catch(() => {});
    logSessionEvent(sessionId, `ws_${wsType}`, getIncomingMessageIp(request), url, 101, undefined, getWebSocketSource(request));

    incrementWsCount(sessionId);
    // decrementWsCount is called inside the bridge on agent WebSocket close.
    const chromeWsUrl = `ws://${cdpBase.host}${cdpPath}`;
    createCdpBridge(sessionId, socket, head, request, chromeWsUrl, () => decrementWsCount(sessionId));
    return;
  } else if (wsType === "pagecast") {
    // Our own screencast: terminated here, not proxied. The producer sets the
    // viewport and starts the stream on one and the same CDP session, which is
    // what makes the page actually reflow to the viewer's width (proxying
    // Steel's cast cannot: it owns its session's device metrics).
    const targetId = qs.get("targetId") ?? qs.get("pageId");
    if (!targetId) {
      console.warn("[ws-proxy] rejecting pagecast: missing targetId", { sessionId });
      socket.destroy();
      return;
    }
    prisma.session.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() },
    }).catch(() => {});
    logSessionEvent(sessionId, "ws_pagecast", getIncomingMessageIp(request), url, 101,
      { targetId }, getWebSocketSource(request));
    // A lease id on the cast URL turns this connection into a control channel;
    // without one it stays a strict observer (input dropped server-side).
    const leaseId = qs.get("leaseId") ?? undefined;
    pagecastWss.handleUpgrade(request, socket, head, (viewer) => {
      incrementWsCount(sessionId);
      viewer.once("close", () => decrementWsCount(sessionId));
      attachCastViewer(sessionId, targetId, viewer, leaseId).catch((err) => {
        console.warn(`[cast] failed to attach viewer for ${targetId}:`, err);
        try { viewer.close(); } catch { /* already gone */ }
      });
    });
    return;
  } else if (wsType === "vnc") {
    // Forward to websockify (port 6080) which bridges the noVNC WebSocket client to
    // x0vncserver's plain TCP VNC port (5900). x0vncserver (TigerVNC) has no built-in
    // WebSocket support, so websockify can bridge cleanly without protocol conflicts.
    const containerUrl = new URL(session.internalApiUrl!);
    containerUrl.port = "6080";
    proxyTarget = containerUrl.origin;
    request.url = "/";
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
  logSessionEvent(sessionId, `ws_${wsType}`, getIncomingMessageIp(request), url, 101, undefined, getWebSocketSource(request));

  incrementWsCount(sessionId);
  const releaseOnce = createWsRelease(sessionId);
  socket.once("close", releaseOnce);
  socket.once("error", releaseOnce);

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

const PAGE_TRANSITION_RETRY_MS = 100;
const PAGE_TRANSITION_TIMEOUT_MS = 3000;
const PAGE_NOT_ATTACHED_ERROR = "Not attached to an active page";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPageAttachmentError(err: unknown): boolean {
  return String(err).includes(PAGE_NOT_ATTACHED_ERROR);
}

async function waitForPageTargetReady(sessionId: string, targetId: string): Promise<void> {
  const deadline = Date.now() + PAGE_TRANSITION_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await executeCdpCommand(sessionId, "Page.getFrameTree", {}, targetId);
      return;
    } catch (err) {
      if (!isTransientPageAttachmentError(err)) throw err;
      lastError = err;
      await sleep(PAGE_TRANSITION_RETRY_MS);
    }
  }

  throw lastError ?? new Error(`Timed out waiting for target ${targetId} to become page-ready`);
}

async function executePageCommandWhenReady(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  targetId: string
): Promise<Record<string, unknown>> {
  try {
    return await executeCdpCommand(sessionId, method, params, targetId);
  } catch (err) {
    if (!isTransientPageAttachmentError(err)) throw err;
    await waitForPageTargetReady(sessionId, targetId);
    return executeCdpCommand(sessionId, method, params, targetId);
  }
}

export async function handleGetTargets(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  try {
    const result = await executeCdpCommand(sessionId, "Target.getTargets", {});
    const targets = ((result.targetInfos ?? []) as CdpTarget[]).filter(
      (t) => t.type === "page"
    );
    logSessionEvent(sessionId, "targets_list", request.ip, request.url, 200, undefined, getHttpSource(request));
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const url = (request.body as { url?: string })?.url ?? "chrome://newtab/";
  try {
    const result = await executeCdpCommand(sessionId, "Target.createTarget", { url });
    logSessionEvent(sessionId, "targets_create", request.ip, request.url, 200, { url }, getHttpSource(request));
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  try {
    await executeCdpCommand(sessionId, "Target.closeTarget", { targetId });
    logSessionEvent(sessionId, "targets_close", request.ip, request.url, 200, { targetId }, getHttpSource(request));
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  try {
    await executeCdpCommand(sessionId, "Target.activateTarget", { targetId });
    logSessionEvent(sessionId, "targets_activate", request.ip, request.url, 200, { targetId }, getHttpSource(request));
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

// A lease lookup that cannot run must not take the endpoint down with it: an
// arbitration outage degrades to previous behaviour (allow) rather than 500.
// The CDP bridge does the same — refusing everything would strand the agent.
async function leaseHolderBlocking(
  sessionId: string, targetId: string, leaseId: string | null
) {
  try {
    return await isLockedByOther(sessionId, targetId, leaseId);
  } catch (err) {
    console.warn(`[lease] arbitration unavailable for ${targetId}:`, err);
    return null;
  }
}

// Callers that hold the lease pass it along so their own writes aren't refused.
function leaseIdOf(request: { body?: unknown; query?: unknown }): string | null {
  const b = request.body as Record<string, unknown> | undefined;
  const q = request.query as Record<string, unknown> | undefined;
  const v = (b?.leaseId ?? q?.leaseId);
  return typeof v === "string" && v ? v : null;
}

// ── Takeover lease ─────────────────────────────────────────────────────────
export async function handleAcquireLease(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string }; Body: { holderKey?: string; holderLabel?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const holderKey = String((request.body as any)?.holderKey ?? "").slice(0, 128);
  const holderLabel = (request.body as any)?.holderLabel
    ? String((request.body as any).holderLabel).slice(0, 120) : null;
  if (!holderKey) return reply.status(400).send({ error: "holderKey required" });

  const res = await acquireLease(sessionId, targetId, holderKey, holderLabel);
  if (!res.ok) {
    if (res.reason === "held") {
      return reply.status(409).send({
        error: "held", holderLabel: res.holderLabel, expiresAt: res.expiresAt,
      });
    }
    return reply.status(409).send({ error: "stale" });
  }
  logSessionEvent(sessionId, "lease_acquire", request.ip, request.url, 200,
    { targetId }, getHttpSource(request));
  return reply.send({
    ok: true, leaseId: res.lease.leaseId, expiresAt: res.lease.expiresAt,
    renewAfterMs: LEASE_RENEW_HINT_MS,
  });
}

export async function handleRenewLease(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string }; Body: { leaseId?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });
  const leaseId = String((request.body as any)?.leaseId ?? "");
  const res = await renewLease(sessionId, targetId, leaseId);
  if (!res.ok) return reply.status(409).send({ error: "stale" });
  return reply.send({ ok: true, expiresAt: res.lease.expiresAt, renewAfterMs: LEASE_RENEW_HINT_MS });
}

export async function handleReleaseLease(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string }; Body: { leaseId?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });
  await releaseLease(sessionId, targetId, String((request.body as any)?.leaseId ?? ""));
  logSessionEvent(sessionId, "lease_release", request.ip, request.url, 200,
    { targetId }, getHttpSource(request));
  return reply.send({ ok: true });
}

export async function handleGetLease(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });
  const lease = await currentLease(sessionId, targetId);
  return reply.send({ held: !!lease, holderLabel: lease?.holderLabel ?? null,
                      expiresAt: lease?.expiresAt ?? null });
}

export async function handleSetTargetViewport(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string }; Body: { width: number; height: number; deviceScaleFactor?: number } }>,
  reply: FastifyReply
) {
  // 按 **单个 page target** 覆盖视口。与 /resize 的区别：那个改的是 X display + 窗口
  // 边界（整个 session 共用），把一个 target 缩到嵌入方的宽度会连累其它 target；
  // Emulation.setDeviceMetricsOverride 走 flat session，只作用于这一个页面。
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const body = request.body as {
    width?: unknown; height?: unknown; deviceScaleFactor?: unknown; zoom?: unknown;
  };
  const width = Math.floor(Number(body?.width));
  const height = Math.floor(Number(body?.height));
  const dsf = body?.deviceScaleFactor === undefined ? 1 : Number(body.deviceScaleFactor);
  const zoom = body?.zoom === undefined ? 1 : Number(body.zoom);
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width < 320 || height < 240 || width > 3840 || height > 2160) {
    return reply.status(400).send({ error: "width/height out of range (320x240..3840x2160)" });
  }
  if (!Number.isFinite(dsf) || dsf < 0.5 || dsf > 4) {
    return reply.status(400).send({ error: "deviceScaleFactor out of range (0.5..4)" });
  }
  if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 3) {
    return reply.status(400).send({ error: "zoom out of range (0.25..3)" });
  }

  try {
    // Persistent flat session: an override dies with the session that set it, so
    // a fire-and-forget attach (what executeCdpCommand does) would be undone the
    // instant the call returns.
    await setTargetViewport(sessionId, targetId, width, height, dsf, zoom);
    logSessionEvent(sessionId, "target_viewport", request.ip, request.url, 200,
      { targetId, width, height, deviceScaleFactor: dsf, zoom }, getHttpSource(request));
    return reply.send({ ok: true, width, height, deviceScaleFactor: dsf, zoom });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

export async function handleReapplyTargetViewport(
  request: FastifyRequest<{ Params: { id: string; targetId: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  // Steel's cast handler re-sets device metrics from session.dimensions every
  // time a viewer connects, clobbering our override. Viewers call this right
  // after their stream starts to re-assert the viewport they asked for.
  const { id: sessionId, targetId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });
  try {
    const applied = await reapplyTargetViewport(sessionId, targetId);
    return reply.send({ ok: true, applied });
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { url, targetId } = request.body as { url: string; targetId: string };
  if (!url || !targetId) return reply.status(400).send({ error: "url and targetId required" });
  const navBlocked = await leaseHolderBlocking(sessionId, targetId, leaseIdOf(request));
  if (navBlocked) {
    return reply.status(409).send({ error: "held", holderLabel: navBlocked.holderLabel });
  }

  try {
    const result = await executeCdpCommand(sessionId, "Page.navigate", { url }, targetId);
    logSessionEvent(sessionId, "navigate", request.ip, request.url, 200, { url, targetId }, getHttpSource(request));
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { targetId } = request.body as { targetId: string };
  const blocked = await leaseHolderBlocking(sessionId, targetId, leaseIdOf(request));
  if (blocked) return reply.status(409).send({ error: "held", holderLabel: blocked.holderLabel });
  try {
    // Page.goBack doesn't exist in CDP; use getNavigationHistory + navigateToHistoryEntry
    const history = await executeCdpCommand(sessionId, "Page.getNavigationHistory", {}, targetId);
    const currentIndex = history.currentIndex as number;
    const entries = history.entries as Array<{ id: number }>;
    if (currentIndex <= 0) return reply.status(400).send({ error: "No previous page in history" });
    const entryId = entries[currentIndex - 1].id;
    await executeCdpCommand(sessionId, "Page.navigateToHistoryEntry", { entryId }, targetId);
    await waitForPageTargetReady(sessionId, targetId);
    logSessionEvent(sessionId, "go_back", request.ip, request.url, 200, { targetId }, getHttpSource(request));
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { targetId } = request.body as { targetId: string };
  try {
    // Page.goForward doesn't exist in CDP; use getNavigationHistory + navigateToHistoryEntry
    const history = await executeCdpCommand(sessionId, "Page.getNavigationHistory", {}, targetId);
    const currentIndex = history.currentIndex as number;
    const entries = history.entries as Array<{ id: number }>;
    if (currentIndex >= entries.length - 1) return reply.status(400).send({ error: "No next page in history" });
    const entryId = entries[currentIndex + 1].id;
    await executeCdpCommand(sessionId, "Page.navigateToHistoryEntry", { entryId }, targetId);
    await waitForPageTargetReady(sessionId, targetId);
    logSessionEvent(sessionId, "go_forward", request.ip, request.url, 200, { targetId }, getHttpSource(request));
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
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const { targetId } = request.body as { targetId: string };
  try {
    await executePageCommandWhenReady(sessionId, "Page.reload", {}, targetId);
    logSessionEvent(sessionId, "reload", request.ip, request.url, 200, { targetId }, getHttpSource(request));
    return reply.send({ ok: true });
  } catch (err) {
    return reply.status(502).send({ error: String(err) });
  }
}

// ─── VNC Viewer ───────────────────────────────────────────────────────────────
// GET /api/sessions/:id/vnc-viewer?token=xxx
// Serves an HTML page with the noVNC client connected to the session's VNC stream.
// The noVNC client connects via WebSocket to /ws/sessions/:id/vnc, which is proxied
// to the container's websockify bridge (port 6080) → x11vnc → Xvfb :10 (full Chrome UI).

// Resize the remote desktop to match the viewer window: first the X screen
// (via xrandr inside the workload), then Chrome's window to fill it.
//
// The screen resize is done server-side rather than by the VNC client because
// noVNC refuses to send RFB SetDesktopSize while it is in viewOnly mode — which
// is exactly the default "observe" mode of the session view. Driving both from
// here also keeps the two sizes from diverging.
export async function handleResizeSession(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { width: number; height: number } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });
  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const body = request.body as { width?: unknown; height?: unknown };
  const width = Math.floor(Number(body?.width));
  const height = Math.floor(Number(body?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width < 320 || height < 240 || width > 3840 || height > 2160) {
    return reply.status(400).send({ error: "width/height out of range (320x240..3840x2160)" });
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { containerId: true },
  });
  if (!session?.containerId) return reply.status(404).send({ error: "Container not found" });

  try {
    await driver.resizeDisplay(sessionId, session.containerId, width, height);
    const targets = await executeCdpCommand(sessionId, "Target.getTargets");
    const page = (targets.targetInfos as Array<{ targetId: string; type: string }> | undefined)
      ?.find((t) => t.type === "page");
    if (!page) return reply.status(502).send({ error: "No page target" });
    const win = await executeCdpCommand(sessionId, "Browser.getWindowForTarget", { targetId: page.targetId });
    await executeCdpCommand(sessionId, "Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { left: 0, top: 0, width, height, windowState: "normal" },
    });
    logSessionEvent(sessionId, "resize", request.ip, request.url, 200, { width, height }, getHttpSource(request));
    return reply.send({ ok: true, width, height });
  } catch (err) {
    const detail = err instanceof Error ? err.message : JSON.stringify(err);
    console.warn(`[resize] Session ${sessionId}: resize to ${width}x${height} failed:`, detail);
    return reply.status(502).send({ error: detail });
  }
}

export async function handleVncViewer(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });

  const context = await getSessionProxyContext(sessionId, token);
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  // Build the WebSocket URL client-side so it always matches the page protocol
  // (ws: for HTTP, wss: for HTTPS), regardless of X-Forwarded-Proto headers.
  const vncWsPath = `/ws/sessions/${sessionId}/vnc?token=${encodeURIComponent(token)}`;
  const clipboardApiUrl = `/api/sessions/${sessionId}/clipboard?token=${encodeURIComponent(token)}`;
  const resizeApiUrl = `/api/sessions/${sessionId}/resize?token=${encodeURIComponent(token)}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser Session</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #1a1a1a; overflow: hidden; }
    #screen { width: 100%; height: 100%; }
    #screen canvas { display: block; }
    #status {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      color: #999; font-family: sans-serif; font-size: 13px;
      background: rgba(0,0,0,0.6); padding: 8px 16px; border-radius: 6px;
    }
  </style>
</head>
<body>
  <div id="screen"></div>
  <div id="status">Connecting...</div>
  <script type="module">
    import RFB from '/novnc/core/rfb.js';

    const statusEl = document.getElementById('status');
    const screenEl = document.getElementById('screen');

    // --- Clipboard bridge ---
    // noVNC registers its keydown listener on window in capture phase. Any
    // listener added AFTER new RFB() is queued behind noVNC's, and noVNC calls
    // stopImmediatePropagation(), so real keyboard events never reach our handler
    // (synthetic dispatchEvent bypasses this, which is why manual testing worked).
    //
    // Fix: register on window BEFORE new RFB() — same target + capture phase,
    // first registered wins. Clipboard API is also unreliable in iframes, so we
    // delegate reads to the parent via postMessage.

    const pendingClipboard = new Map();
    let rfb = null; // assigned below, after listeners are registered

    function requestClipboardFromParent() {
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        const timer = setTimeout(() => {
          pendingClipboard.delete(id);
          reject(new Error('timeout'));
        }, 2000);
        pendingClipboard.set(id, { resolve, reject, timer });
        window.parent.postMessage({ type: 'requestClipboardRead', requestId: id }, '*');
      });
    }

    async function pasteText(text) {
      if (!rfb || !text) return;
      try {
        // Ask the backend to set the X11 CLIPBOARD selection via xclip inside
        // the container. x0vncserver's ClientCutText only sets PRIMARY, which
        // Chrome ignores; xclip sets CLIPBOARD directly so Ctrl+V works.
        const res = await fetch('${clipboardApiUrl}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error('clipboard API ' + res.status);
      } catch (err) {
        console.warn('[vnc] clipboard API failed, falling back to keystroke typing:', err);
        // Fallback: type character by character via X11 keysyms
        for (const char of text) {
          const cp = char.codePointAt(0);
          const keysym = cp <= 0x7e ? cp : (0x01000000 + cp);
          rfb.sendKey(keysym, '', true);
          rfb.sendKey(keysym, '', false);
          if (text.length > 1) await new Promise(r => setTimeout(r, 8));
        }
        return;
      }
      // xclip has set CLIPBOARD — send Ctrl+V to remote Chrome
      rfb.sendKey(0xffe3, 'ControlLeft', true);
      rfb.sendKey(0x76,   'KeyV',        true);
      rfb.sendKey(0x76,   'KeyV',        false);
      rfb.sendKey(0xffe3, 'ControlLeft', false);
    }

    // Register BEFORE new RFB() to guarantee priority over noVNC's listener
    window.addEventListener('keydown', async (e) => {
      if (!rfb) return;
      const isPaste = (e.ctrlKey || e.metaKey) && e.key === 'v';
      if (!isPaste) return;
      e.stopPropagation();
      e.preventDefault();
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        try {
          text = await requestClipboardFromParent();
        } catch (err) {
          console.warn('[vnc] clipboard unavailable:', err);
        }
      }
      // Release any locally-held modifier keys before typing so they don't
      // bleed into the typed characters on the remote side.
      if (e.ctrlKey)  rfb.sendKey(0xffe3, 'ControlLeft',  false);
      if (e.metaKey)  rfb.sendKey(0xffe7, 'MetaLeft',     false);
      if (e.shiftKey) rfb.sendKey(0xffe1, 'ShiftLeft',    false);
      if (e.altKey)   rfb.sendKey(0xffe9, 'AltLeft',      false);
      await pasteText(text);
    }, true /* capture phase */);

    // Handle messages from parent page (triggerPaste, clipboard responses)
    window.addEventListener('message', async (e) => {
      if (e.data?.type === 'clipboardReadResponse') {
        const req = pendingClipboard.get(e.data.requestId);
        if (req) {
          clearTimeout(req.timer);
          pendingClipboard.delete(e.data.requestId);
          if (e.data.error) req.reject(new Error(e.data.error));
          else req.resolve(e.data.text || '');
        }
      }
      if (e.data?.type === 'triggerPaste') {
        await pasteText(e.data.text || '');
      }
      if (e.data?.type === 'setViewOnly') {
        if (rfb) {
          rfb.viewOnly = Boolean(e.data.value);
          applyViewOnlyCursor(Boolean(e.data.value));
        }
      }
    });

    // Build WebSocket URL client-side to match the page protocol (ws/wss).
    const _wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const _vncWsUrl = _wsProto + '//' + window.location.host + '${vncWsPath}';

    // In view-only mode, noVNC still sets cursor:none on its canvas to render the
    // remote cursor itself. Override all descendant canvases so the system pointer
    // is visible when the user is just watching.
    function applyViewOnlyCursor(isViewOnly) {
      const canvas = screenEl.querySelector('canvas');
      if (canvas) canvas.style.cursor = isViewOnly ? 'default' : '';
    }

    // Create the VNC connection (after listeners, so our keydown handler runs first)
    rfb = new RFB(screenEl, _vncWsUrl);
    // Adaptive resolution is driven by the backend (/resize below): noVNC's own
    // resizeSession is suppressed in viewOnly mode, which is this viewer's
    // default. scaleViewport stays on so the picture still fits while a resize
    // is in flight, or on sessions whose image predates the Xvnc switch.
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = true;

    // Ask the backend to match the remote desktop to this viewer's size
    // (debounced; also once on connect). A ResizeObserver rather than a window
    // resize listener: the viewer is an iframe that also changes size when the
    // sidebar collapses or the panel layout changes, without the window
    // resizing at all.
    let resizeTimer = null;
    let lastSent = '';
    function syncRemoteSize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        const w = Math.floor(screenEl.clientWidth);
        const h = Math.floor(screenEl.clientHeight);
        if (w < 320 || h < 240) return;
        const key = w + 'x' + h;
        if (key === lastSent) return;
        lastSent = key;
        try {
          const res = await fetch('${resizeApiUrl}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ width: w, height: h }),
          });
          if (!res.ok) lastSent = ''; // let the next observation retry
        } catch (err) {
          lastSent = '';
          console.warn('[vnc] remote resize failed:', err);
        }
      }, 400);
    }
    new ResizeObserver(syncRemoteSize).observe(screenEl);

    rfb.addEventListener('connect', () => {
      statusEl.style.display = 'none';
      screenEl.focus();
      // noVNC sets cursor:none on the canvas after connect — re-apply our override.
      applyViewOnlyCursor(rfb.viewOnly);
      syncRemoteSize();
    });
    rfb.addEventListener('disconnect', (e) => {
      statusEl.style.display = '';
      statusEl.textContent = e.detail.clean ? 'Session ended' : 'Connection lost';
    });
    rfb.addEventListener('credentialsrequired', () => {
      rfb.sendCredentials({ password: '' });
    });

    // Sync clipboard from VNC session back to the local browser clipboard
    rfb.addEventListener('clipboard', async (e) => {
      const text = e.detail.text;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        window.parent.postMessage({ type: 'requestClipboardWrite', text, requestId: Math.random().toString(36).slice(2) }, '*');
      }
    });
  </script>
</body>
</html>`;

  await updateLastActiveAt(sessionId);
  logSessionEvent(sessionId, "vnc_view", request.ip, request.url, 200, undefined, "frontend");
  return reply
    .header("Content-Type", "text/html; charset=utf-8")
    .header("X-Frame-Options", "SAMEORIGIN")
    .send(html);
}

export async function handleSetClipboard(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { token?: string }; Body: { text: string } }>,
  reply: FastifyReply
) {
  const { id: sessionId } = request.params;
  const token = request.query.token;
  if (!token) return reply.status(401).send({ error: "Missing token" });

  const context = await getSessionProxyContext(sessionId, token, { wake: true });
  if (!context) return reply.status(401).send({ error: "Invalid token" });

  const body = request.body as { text?: unknown };
  if (typeof body?.text !== "string" || !body.text) {
    return reply.status(400).send({ error: "Missing text" });
  }

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session?.containerId) return reply.status(404).send({ error: "Container not found" });

  await driver.setClipboard(sessionId, session.containerId, body.text);
  return reply.send({ ok: true });
}
