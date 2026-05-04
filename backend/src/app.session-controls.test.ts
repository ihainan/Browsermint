import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { AppPrismaClient } from "./db/client.js";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
});

const { createApp } = await import("./app.js");
const { config } = await import("./config.js");
const { setPrismaForTests } = await import("./db/client.js");
const {
  resetCdpServiceOverridesForTests,
  setCdpServiceOverridesForTests,
} = await import("./services/cdp.service.js");
const {
  resetDockerServiceOverridesForTests,
  setDockerServiceOverridesForTests,
} = await import("./services/docker.service.js");

const owner = {
  id: "user-owner",
  username: "owner",
  email: "owner@example.com",
  isAdmin: false,
  isActive: true,
};

function sessionToken(sessionId = "session-running") {
  return jwt.sign(
    { sub: owner.id, sessionId, type: "session" },
    config.JWT_SESSION_TOKEN_SECRET,
    { expiresIn: "15m" }
  );
}

function makePrismaMock(options: { userActive?: boolean } = {}) {
  const events: unknown[] = [];
  const userActive = options.userActive ?? true;
  const prisma = {
    session: {
      findFirst: async (args: { where: { id?: string; userId?: string; user?: { isActive?: boolean }; deletedAt?: null; status?: { in: string[] } }; select?: Record<string, unknown> }) => {
        if (args.where.id !== "session-running") return null;
        if (args.where.userId !== owner.id) return null;
        if (args.where.user?.isActive === true && !userActive) return null;
        const session = {
          id: "session-running",
          containerName: "browsermint-session-running",
          internalApiUrl: "http://127.0.0.1:3000",
          tokenIssuedAt: null,
        };
        if (!args.select) return session;
        return Object.fromEntries(Object.keys(args.select).map((key) => [key, session[key as keyof typeof session]]));
      },
      findUnique: async (args: { where: { id: string } }) => {
        if (args.where.id !== "session-running") return null;
        return { id: "session-running", containerId: "container-running" };
      },
      update: async () => ({}),
    },
    sessionEvent: {
      create: async (args: { data: unknown }) => {
        events.push(args.data);
        return args.data;
      },
    },
    $on: () => {},
    $disconnect: async () => {},
    __events: events,
  };

  return prisma as unknown as AppPrismaClient & { __events: unknown[] };
}

type ExecuteCdpCommandOverride = (
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
  targetId?: string
) => Promise<Record<string, unknown>>;

async function makeApp(options: { userActive?: boolean; executeCdpCommand?: ExecuteCdpCommandOverride } = {}) {
  const prisma = makePrismaMock(options);
  const calls: Array<{ sessionId: string; method: string; params: Record<string, unknown>; targetId?: string }> = [];
  const dockerCalls: Array<{ containerId: string; text: string }> = [];
  setPrismaForTests(prisma);
  const defaultExecuteCdpCommand: ExecuteCdpCommandOverride = async (sessionId, method, params = {}, targetId) => {
    calls.push({ sessionId, method, params, targetId });
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "page-1", type: "page", title: "Page", url: "https://example.com" },
          { targetId: "worker-1", type: "worker", title: "Worker", url: "" },
        ],
      };
    }
    if (method === "Target.createTarget") return { targetId: "created-target" };
    if (method === "Page.navigate") return { frameId: "frame-1" };
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };
    }
    return {};
  };
  setCdpServiceOverridesForTests({
    executeCdpCommand: options.executeCdpCommand ?? defaultExecuteCdpCommand,
  });
  setDockerServiceOverridesForTests({
    setContainerClipboard: async (containerId, text) => {
      dockerCalls.push({ containerId, text });
    },
  });
  const app = await createApp({ logger: false, serveStatic: false });
  return { app, prisma, calls, dockerCalls };
}

async function closeApp(app: Awaited<ReturnType<typeof createApp>>) {
  await app.close();
  resetCdpServiceOverridesForTests();
  resetDockerServiceOverridesForTests();
}

test("session target routes validate tokens, call CDP, and sanitize logged token paths", async () => {
  const { app, prisma, calls } = await makeApp();
  const token = sessionToken();
  try {
    const missingToken = await app.inject({
      method: "GET",
      url: "/api/sessions/session-running/targets",
    });
    assert.equal(missingToken.statusCode, 401);

    const targets = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/targets?token=${encodeURIComponent(token)}`,
      headers: { "x-browsermint-client": "frontend" },
    });
    assert.equal(targets.statusCode, 200);
    assert.deepEqual(targets.json().targets, [
      { targetId: "page-1", type: "page", title: "Page", url: "https://example.com" },
    ]);
    assert.deepEqual(calls.at(-1), {
      sessionId: "session-running",
      method: "Target.getTargets",
      params: {},
      targetId: undefined,
    });
    assert.deepEqual(prisma.__events.at(-1), {
      sessionId: "session-running",
      operationType: "targets_list",
      sourceIp: "127.0.0.1",
      requestPath: "/api/sessions/session-running/targets",
      statusCode: 200,
      metadata: undefined,
      source: "frontend",
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/targets?token=${encodeURIComponent(token)}`,
      payload: { url: "https://example.org" },
    });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(created.json(), { targetId: "created-target" });
    assert.deepEqual(calls.at(-1), {
      sessionId: "session-running",
      method: "Target.createTarget",
      params: { url: "https://example.org" },
      targetId: undefined,
    });
  } finally {
    await closeApp(app);
  }
});

test("session proxy routes reject tokens for suspended users", async () => {
  const { app, calls } = await makeApp({ userActive: false });
  const token = sessionToken();
  try {
    const targets = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/targets?token=${encodeURIComponent(token)}`,
    });

    assert.equal(targets.statusCode, 401);
    assert.equal(targets.json().error, "Invalid token");
    assert.equal(calls.length, 0);
  } finally {
    await closeApp(app);
  }
});

test("session navigation routes validate body and execute expected CDP commands", async () => {
  const { app, calls } = await makeApp();
  const token = sessionToken();
  try {
    const missingBody = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/navigate?token=${encodeURIComponent(token)}`,
      payload: { url: "https://example.com" },
    });
    assert.equal(missingBody.statusCode, 400);
    assert.equal(missingBody.json().error, "url and targetId required");

    const navigate = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/navigate?token=${encodeURIComponent(token)}`,
      payload: { url: "https://example.com", targetId: "page-1" },
    });
    assert.equal(navigate.statusCode, 200);
    assert.deepEqual(navigate.json(), { frameId: "frame-1" });
    assert.deepEqual(calls.at(-1), {
      sessionId: "session-running",
      method: "Page.navigate",
      params: { url: "https://example.com" },
      targetId: "page-1",
    });

    const back = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/go-back?token=${encodeURIComponent(token)}`,
      payload: { targetId: "page-1" },
    });
    assert.equal(back.statusCode, 200);
    assert.deepEqual(calls.slice(-3), [
      { sessionId: "session-running", method: "Page.getNavigationHistory", params: {}, targetId: "page-1" },
      { sessionId: "session-running", method: "Page.navigateToHistoryEntry", params: { entryId: 10 }, targetId: "page-1" },
      { sessionId: "session-running", method: "Page.getFrameTree", params: {}, targetId: "page-1" },
    ]);

    const forward = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/go-forward?token=${encodeURIComponent(token)}`,
      payload: { targetId: "page-1" },
    });
    assert.equal(forward.statusCode, 200);
    assert.deepEqual(calls.slice(-3), [
      { sessionId: "session-running", method: "Page.getNavigationHistory", params: {}, targetId: "page-1" },
      { sessionId: "session-running", method: "Page.navigateToHistoryEntry", params: { entryId: 12 }, targetId: "page-1" },
      { sessionId: "session-running", method: "Page.getFrameTree", params: {}, targetId: "page-1" },
    ]);

    const reload = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/reload?token=${encodeURIComponent(token)}`,
      payload: { targetId: "page-1" },
    });
    assert.equal(reload.statusCode, 200);
    assert.deepEqual(calls.at(-1), {
      sessionId: "session-running",
      method: "Page.reload",
      params: {},
      targetId: "page-1",
    });
  } finally {
    await closeApp(app);
  }
});

test("session reload retries while history navigation is reattaching the page target", async () => {
  const calls: Array<{ method: string; targetId?: string }> = [];
  let reloadAttempts = 0;
  const { app } = await makeApp({
    executeCdpCommand: async (_sessionId, method, _params = {}, targetId) => {
      calls.push({ method, targetId });
      if (method === "Page.reload" && reloadAttempts++ === 0) {
        throw new Error('{"code":-32000,"message":"Not attached to an active page"}');
      }
      return {};
    },
  });
  const token = sessionToken();
  try {
    const reload = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/reload?token=${encodeURIComponent(token)}`,
      payload: { targetId: "page-1" },
    });

    assert.equal(reload.statusCode, 200);
    assert.deepEqual(reload.json(), { ok: true });
    assert.deepEqual(calls, [
      { method: "Page.reload", targetId: "page-1" },
      { method: "Page.getFrameTree", targetId: "page-1" },
      { method: "Page.reload", targetId: "page-1" },
    ]);
  } finally {
    await closeApp(app);
  }
});

test("browser proxy rewrites websocket URL, injects helpers, and handles upstream failures", async () => {
  const originalFetch = globalThis.fetch;
  const token = sessionToken();
  try {
    globalThis.fetch = async () => new Response(
      "<html><head></head><body><script>const baseWsUrl = 'ws://upstream/cast';</script><canvas></canvas></body></html>",
      { status: 200, headers: { "content-type": "text/html" } }
    );
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/session-running/browser?token=${encodeURIComponent(token)}`,
        headers: { host: "browsermint.example", "x-forwarded-proto": "https" },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /const baseWsUrl = 'wss:\/\/browsermint\.example\/ws\/sessions\/session-running\/cast\?token=/);
      assert.match(res.body, /showContextMenu/);
      assert.match(res.body, /metaKey/);
      assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    } finally {
      await closeApp(app);
    }

    globalThis.fetch = async () => new Response("bad", { status: 503 });
    const failed = await makeApp();
    try {
      const res = await failed.app.inject({
        method: "GET",
        url: `/api/sessions/session-running/browser?token=${encodeURIComponent(token)}`,
      });
      assert.equal(res.statusCode, 502);
    } finally {
      await closeApp(failed.app);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("details proxy rewrites CDP websocket/debugger URLs and reflects token expiry", async () => {
  const originalFetch = globalThis.fetch;
  const token = sessionToken();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/json/version")) {
      return Response.json({ webSocketDebuggerUrl: "ws://172.20.0.2:9223/devtools/browser/browser-id" });
    }
    return Response.json([
      { id: "steel-session", websocketUrl: "ws://upstream/v1/sessions/ws", solveCaptcha: false },
    ]);
  };

  const { app } = await makeApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/details?token=${encodeURIComponent(token)}`,
      headers: { host: "browsermint.example", "x-forwarded-proto": "https" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().id, "steel-session");
    assert.equal(res.json().solveCaptcha, false);
    assert.match(res.json().websocketUrl, /^wss:\/\/browsermint\.example\/ws\/sessions\/session-running\/cdp\/devtools\/browser\/browser-id\?token=/);
    assert.match(res.json().debuggerUrl, /^https:\/\/browsermint\.example\/api\/sessions\/session-running\/devtools\/devtools_app\.html\?token=/);
    assert.match(res.json().tokenExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
    await closeApp(app);
  }
});

test("VNC viewer and clipboard routes validate tokens and target the session container", async () => {
  const token = sessionToken();
  const { app, dockerCalls } = await makeApp();
  try {
    const missingToken = await app.inject({
      method: "GET",
      url: "/api/sessions/session-running/vnc-viewer",
    });
    assert.equal(missingToken.statusCode, 401);

    const viewer = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/vnc-viewer?token=${encodeURIComponent(token)}`,
    });
    assert.equal(viewer.statusCode, 200);
    assert.match(viewer.body, /\/ws\/sessions\/session-running\/vnc\?token=/);
    assert.match(viewer.body, /\/api\/sessions\/session-running\/clipboard\?token=/);
    assert.equal(viewer.headers["x-frame-options"], "SAMEORIGIN");

    const missingText = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/clipboard?token=${encodeURIComponent(token)}`,
      payload: { text: "" },
    });
    assert.equal(missingText.statusCode, 400);

    const clipboard = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/clipboard?token=${encodeURIComponent(token)}`,
      payload: { text: "copy me" },
    });
    assert.equal(clipboard.statusCode, 200);
    assert.deepEqual(clipboard.json(), { ok: true });
    assert.deepEqual(dockerCalls, [{ containerId: "container-running", text: "copy me" }]);
  } finally {
    await closeApp(app);
  }
});

test("DevTools proxy resolves page targets, rewrites ws parameter, and stores token cookie", async () => {
  const originalFetch = globalThis.fetch;
  const token = sessionToken();
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/json/list")) {
      return Response.json([
        { id: "page-1", type: "page", webSocketDebuggerUrl: "ws://172.20.0.2:9223/devtools/page/page-1" },
        { id: "page-2", type: "page", webSocketDebuggerUrl: "ws://172.20.0.2:9223/devtools/page/page-2" },
        { id: "worker-1", type: "worker", webSocketDebuggerUrl: "ws://172.20.0.2:9223/devtools/worker/worker-1" },
      ]);
    }
    return new Response("<html>devtools</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  const { app, prisma } = await makeApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/devtools/devtools_app.html?token=${encodeURIComponent(token)}&pageId=page-2`,
      headers: { host: "browsermint.example" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "<html>devtools</html>");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(String(res.headers["content-type"]), /text\/html/);
    assert.match(String(res.headers["set-cookie"]), /browsermint_devtools_session-running=/);
    assert.match(String(res.headers["set-cookie"]), /HttpOnly/);

    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[0], /\/json\/list$/);
    const upstream = new URL(requestedUrls[1]);
    assert.equal(upstream.pathname, "/devtools/devtools_app.html");
    assert.match(
      upstream.searchParams.get("ws") ?? "",
      /^\/\/browsermint\.example\/ws\/sessions\/session-running\/cdp\/devtools\/page\/page-2\?token=/
    );
    assert.deepEqual(prisma.__events.at(-1), {
      sessionId: "session-running",
      operationType: "devtools",
      sourceIp: "127.0.0.1",
      requestPath: "/api/sessions/session-running/devtools/devtools_app.html?pageId=page-2",
      statusCode: 200,
      metadata: undefined,
      source: "frontend",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await closeApp(app);
  }
});

test("DevTools target route returns the first available page target path", async () => {
  const originalFetch = globalThis.fetch;
  const token = sessionToken();
  globalThis.fetch = async () => Response.json([
    { id: "worker-1", type: "worker", webSocketDebuggerUrl: "ws://172.20.0.2:9223/devtools/worker/worker-1" },
    { id: "page-1", type: "page", webSocketDebuggerUrl: "ws://172.20.0.2:9223/devtools/page/page-1" },
  ]);

  const { app } = await makeApp();
  try {
    const missingToken = await app.inject({
      method: "GET",
      url: "/api/sessions/session-running/devtools-target",
    });
    assert.equal(missingToken.statusCode, 401);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/devtools-target?token=${encodeURIComponent(token)}`,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { pageId: "page-1", wsPath: "/devtools/page/page-1" });
  } finally {
    globalThis.fetch = originalFetch;
    await closeApp(app);
  }
});
