import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { AddressInfo, Socket } from "node:net";
import { createServer } from "node:http";
import jwt from "jsonwebtoken";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { AppPrismaClient } from "../db/client.js";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const {
  getRequestProtocols,
  handleWebSocketUpgrade,
  getHttpSource,
  getIncomingMessageIp,
  getWebSocketSource,
  parseSessionWebSocketPath,
  proxyServer,
  resetProxyServiceOverridesForTests,
  rewriteUpstreamWebSocketUrl,
  sanitizeRequestPath,
  setProxyServiceOverridesForTests,
} = await import("./proxy.service.js");
const { config } = await import("../config.js");
const { setPrismaForTests } = await import("../db/client.js");
const {
  resetCdpServiceOverridesForTests,
  setCdpServiceOverridesForTests,
} = await import("./cdp.service.js");
const {
  resetDockerServiceOverridesForTests,
  setDockerServiceOverridesForTests,
} = await import("./docker.service.js");

class TestSocket extends Duplex {
  destroyCalled = false;

  _read() {}

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback();
  }

  destroy(error?: Error): this {
    this.destroyCalled = true;
    return super.destroy(error);
  }
}

function makeWsRequest(url: string): IncomingMessage {
  return {
    url,
    headers: { host: "browsermint.example" },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function makeSessionToken(payload: { sessionId?: string; userId?: string; iat?: number } = {}) {
  return jwt.sign(
    {
      sub: payload.userId ?? "user-owner",
      sessionId: payload.sessionId ?? "session-running",
      type: "session",
      ...(payload.iat ? { iat: payload.iat } : {}),
    },
    config.JWT_SESSION_TOKEN_SECRET,
    { expiresIn: "15m" }
  );
}

async function waitFor<T>(
  predicate: () => T | undefined,
  message: string,
  timeoutMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function setProxyPrismaMock(session: {
  id?: string;
  userId?: string;
  status?: string;
  containerId?: string | null;
  containerName?: string | null;
  internalApiUrl?: string | null;
  tokenIssuedAt?: Date | null;
  userActive?: boolean;
} | null) {
  const events: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    session: {
      findFirst: async (args?: { where?: { id?: string; userId?: string; user?: { isActive?: boolean } } }) => {
        if (!session) return null;
        const sessionId = session.id ?? "session-running";
        const userId = session.userId ?? "user-owner";
        if (args?.where?.id && args.where.id !== sessionId) return null;
        if (args?.where?.userId && args.where.userId !== userId) return null;
        if (args?.where?.user?.isActive === true && session.userActive === false) return null;
        return {
          id: sessionId,
          status: session.status ?? "running",
          containerId: "containerId" in session ? session.containerId : "container-running",
          containerName: "containerName" in session ? session.containerName : "browsermint-session-running",
          internalApiUrl: "internalApiUrl" in session ? session.internalApiUrl : "http://127.0.0.1:3000",
          tokenIssuedAt: "tokenIssuedAt" in session ? session.tokenIssuedAt : null,
        };
      },
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      },
    },
    sessionEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        events.push(args.data);
        return {};
      },
    },
    $on: () => {},
    $disconnect: async () => {},
  };
  setPrismaForTests(prisma as unknown as AppPrismaClient);
  return { events, updates };
}

test("sanitizeRequestPath removes token without dropping other query params", () => {
  assert.equal(sanitizeRequestPath("/api/sessions/s1/details?token=secret&page=1"), "/api/sessions/s1/details?page=1");
  assert.equal(sanitizeRequestPath("/api/sessions/s1/details?page=1&token=secret"), "/api/sessions/s1/details?page=1");
  assert.equal(sanitizeRequestPath("/api/sessions/s1/details?token=secret"), "/api/sessions/s1/details");
  assert.equal(
    sanitizeRequestPath("/ws/sessions/s1/cast?token=secret?pageId=p1&pageIndex=2"),
    "/ws/sessions/s1/cast?pageId=p1&pageIndex=2"
  );
});

test("getRequestProtocols trusts forwarded proto before origin or referer", () => {
  assert.deepEqual(getRequestProtocols({ headers: { "x-forwarded-proto": "https" } }), { http: "https", ws: "wss" });
  assert.deepEqual(getRequestProtocols({ headers: { origin: "https://app.example" } }), { http: "https", ws: "wss" });
  assert.deepEqual(getRequestProtocols({ headers: { referer: "http://app.example/path" } }), { http: "http", ws: "ws" });
});

test("parseSessionWebSocketPath parses standard and double-question-mark URLs", () => {
  assert.deepEqual(parseSessionWebSocketPath("/ws/sessions/s1/cdp/devtools/page/1?token=t1"), {
    sessionId: "s1",
    wsType: "cdp",
    wsSubPath: "/devtools/page/1",
    token: "t1",
  });

  assert.deepEqual(parseSessionWebSocketPath("/ws/sessions/s1/cast?token=t1?pageId=p1"), {
    sessionId: "s1",
    wsType: "cast",
    wsSubPath: "/",
    token: "t1",
  });

  assert.equal(parseSessionWebSocketPath("/not/a/session/path"), null);
});

test("rewriteUpstreamWebSocketUrl keeps CDP subpath while routing through Browsermint", () => {
  const rewritten = rewriteUpstreamWebSocketUrl(
    { headers: { host: "browsermint.example", "x-forwarded-proto": "https" } },
    "session-1",
    "session-token",
    "ws://172.18.0.2:9223/devtools/page/abc"
  );

  assert.equal(rewritten, "wss://browsermint.example/ws/sessions/session-1/cdp/devtools/page/abc?token=session-token");
});

test("source helpers classify frontend and agent traffic", () => {
  assert.equal(getHttpSource({ headers: { "x-browsermint-client": "frontend" } }), "frontend");
  assert.equal(getHttpSource({ headers: {} }), "agent");

  assert.equal(getWebSocketSource({ headers: { origin: "https://browsermint.example", host: "browsermint.example" } }), "frontend");
  assert.equal(getWebSocketSource({ headers: { origin: "https://agent.example", host: "browsermint.example" } }), "agent");
  assert.equal(getWebSocketSource({ headers: { host: "browsermint.example" } }), "agent");
});

test("getIncomingMessageIp prefers x-forwarded-for before socket address", () => {
  assert.equal(
    getIncomingMessageIp({
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.2" },
    } as never),
    "203.0.113.10"
  );

  assert.equal(
    getIncomingMessageIp({
      headers: {},
      socket: { remoteAddress: "10.0.0.2" },
    } as never),
    "10.0.0.2"
  );
});

test("handleWebSocketUpgrade rejects missing, invalid, wrong-session, wrong-user, and superseded tokens", async () => {
  setProxyPrismaMock(null);

  const missingTokenSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest("/ws/sessions/session-running/cdp/devtools/page/1"),
    missingTokenSocket,
    Buffer.alloc(0)
  );
  assert.equal(missingTokenSocket.destroyCalled, true);

  const invalidTokenSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest("/ws/sessions/session-running/cdp/devtools/page/1?token=not-a-token"),
    invalidTokenSocket,
    Buffer.alloc(0)
  );
  assert.equal(invalidTokenSocket.destroyCalled, true);

  const wrongSessionSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest(`/ws/sessions/session-running/cdp/devtools/page/1?token=${encodeURIComponent(makeSessionToken({ sessionId: "other-session" }))}`),
    wrongSessionSocket,
    Buffer.alloc(0)
  );
  assert.equal(wrongSessionSocket.destroyCalled, true);

  setProxyPrismaMock({ userId: "user-owner" });
  const wrongUserSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest(`/ws/sessions/session-running/cdp/devtools/page/1?token=${encodeURIComponent(makeSessionToken({ userId: "user-other" }))}`),
    wrongUserSocket,
    Buffer.alloc(0)
  );
  assert.equal(wrongUserSocket.destroyCalled, true);

  const issuedAt = Math.floor(Date.now() / 1000) - 10;
  setProxyPrismaMock({ tokenIssuedAt: new Date((issuedAt + 5) * 1000) });
  const supersededSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest(`/ws/sessions/session-running/cdp/devtools/page/1?token=${encodeURIComponent(makeSessionToken({ iat: issuedAt }))}`),
    supersededSocket,
    Buffer.alloc(0)
  );
  assert.equal(supersededSocket.destroyCalled, true);
});

test("handleWebSocketUpgrade rejects unavailable and malformed paused sessions before proxying", async () => {
  setProxyPrismaMock(null);
  const unavailableSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest(`/ws/sessions/session-running/cast?token=${encodeURIComponent(makeSessionToken())}`),
    unavailableSocket,
    Buffer.alloc(0)
  );
  assert.equal(unavailableSocket.destroyCalled, true);

  setProxyPrismaMock({ status: "paused", containerId: null });
  const pausedWithoutContainerSocket = new TestSocket();
  await handleWebSocketUpgrade(
    makeWsRequest(`/ws/sessions/session-running/cast?token=${encodeURIComponent(makeSessionToken())}`),
    pausedWithoutContainerSocket,
    Buffer.alloc(0)
  );
  assert.equal(pausedWithoutContainerSocket.destroyCalled, true);
});

test("handleWebSocketUpgrade rejects tokens for suspended users", async () => {
  setProxyPrismaMock({ status: "running", userActive: false });
  const socket = new TestSocket();

  await handleWebSocketUpgrade(
    makeWsRequest(`/ws/sessions/session-running/cast?token=${encodeURIComponent(makeSessionToken())}`),
    socket,
    Buffer.alloc(0)
  );

  assert.equal(socket.destroyCalled, true);
});

test("handleWebSocketUpgrade unpauses paused sessions before proxying", async () => {
  const { updates } = setProxyPrismaMock({
    status: "paused",
    containerId: "container-paused",
    internalApiUrl: "http://10.0.0.6:3000",
  });
  const unpausedContainers: string[] = [];
  const cdpInitCalls: Array<{ sessionId: string; internalApiUrl: string }> = [];
  const proxyCalls: Array<{ url: string | undefined; target: unknown }> = [];
  const originalWs = proxyServer.ws;
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  config.IDLE_PAUSE_ENABLED = false;
  setDockerServiceOverridesForTests({
    unpauseContainer: async (containerId) => {
      unpausedContainers.push(containerId);
    },
  });
  setCdpServiceOverridesForTests({
    initCdpSession: async (sessionId, internalApiUrl) => {
      cdpInitCalls.push({ sessionId, internalApiUrl });
      return true;
    },
  });
  proxyServer.ws = ((request: IncomingMessage, socket: Duplex, _head: Buffer, options: { target?: unknown }) => {
    proxyCalls.push({ url: request.url, target: options.target });
    socket.emit("close");
  }) as typeof proxyServer.ws;

  try {
    const socket = new TestSocket();
    await handleWebSocketUpgrade(
      makeWsRequest(`/ws/sessions/session-running/logs?token=${encodeURIComponent(makeSessionToken())}`),
      socket,
      Buffer.alloc(0)
    );

    assert.equal(socket.destroyCalled, false);
    assert.deepEqual(unpausedContainers, ["container-paused"]);
    assert.equal((updates[0] as { data: { status?: string } }).data.status, "running");
    assert.ok((updates[0] as { data: { runningStartedAt?: Date } }).data.runningStartedAt instanceof Date);
    assert.deepEqual(cdpInitCalls, [{
      sessionId: "session-running",
      internalApiUrl: "http://10.0.0.6:3000",
    }]);
    assert.deepEqual(proxyCalls, [{
      url: "/v1/sessions/logs",
      target: "http://10.0.0.6:3000",
    }]);
  } finally {
    proxyServer.ws = originalWs;
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    resetDockerServiceOverridesForTests();
    resetCdpServiceOverridesForTests();
  }
});

test("handleWebSocketUpgrade waits for an in-flight unpause instead of unpausing twice", async () => {
  const session = {
    id: "session-running",
    status: "paused",
    containerId: "container-paused",
    containerName: "browsermint-session-running",
    internalApiUrl: "http://10.0.0.7:3000",
    tokenIssuedAt: null as Date | null,
  };
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    session: {
      findFirst: async (args?: { where?: { user?: { isActive?: boolean } }; select?: Record<string, unknown> }) => {
        if (args?.where?.user?.isActive === true) {
          return { ...session };
        }
        if (args?.select) {
          return Object.fromEntries(
            Object.keys(args.select).map((key) => [key, session[key as keyof typeof session]])
          );
        }
        return { ...session };
      },
      update: async (args: { data: { status?: string; runningStartedAt?: Date } }) => {
        updates.push(args);
        if (args.data.status) session.status = args.data.status;
        return { ...session, ...args.data };
      },
    },
    sessionEvent: { create: async () => ({}) },
    $on: () => {},
    $disconnect: async () => {},
  };
  setPrismaForTests(prisma as unknown as AppPrismaClient);

  let releaseUnpause!: () => void;
  const unpauseRelease = new Promise<void>((resolve) => { releaseUnpause = resolve; });
  let signalUnpauseStarted!: () => void;
  const unpauseStarted = new Promise<void>((resolve) => { signalUnpauseStarted = resolve; });
  const unpausedContainers: string[] = [];
  const proxyCalls: Array<{ url: string | undefined; target: unknown }> = [];
  const originalWs = proxyServer.ws;
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  config.IDLE_PAUSE_ENABLED = false;
  setDockerServiceOverridesForTests({
    unpauseContainer: async (containerId) => {
      unpausedContainers.push(containerId);
      signalUnpauseStarted();
      await unpauseRelease;
    },
  });
  setCdpServiceOverridesForTests({
    initCdpSession: async () => true,
  });
  proxyServer.ws = ((request: IncomingMessage, socket: Duplex, _head: Buffer, options: { target?: unknown }) => {
    proxyCalls.push({ url: request.url, target: options.target });
    socket.emit("close");
  }) as typeof proxyServer.ws;

  try {
    const token = encodeURIComponent(makeSessionToken());
    const firstSocket = new TestSocket();
    const first = handleWebSocketUpgrade(
      makeWsRequest(`/ws/sessions/session-running/logs?token=${token}`),
      firstSocket,
      Buffer.alloc(0)
    );
    await unpauseStarted;

    const secondSocket = new TestSocket();
    const second = handleWebSocketUpgrade(
      makeWsRequest(`/ws/sessions/session-running/cast?token=${token}`),
      secondSocket,
      Buffer.alloc(0)
    );

    releaseUnpause();
    await Promise.all([first, second]);

    assert.equal(firstSocket.destroyCalled, false);
    assert.equal(secondSocket.destroyCalled, false);
    assert.deepEqual(unpausedContainers, ["container-paused"]);
    assert.equal(updates.filter((update) => (update as { data: { status?: string } }).data.status === "running").length, 1);
    assert.deepEqual(proxyCalls, [
      { url: "/v1/sessions/logs", target: "http://10.0.0.7:3000" },
      { url: "/v1/sessions/cast", target: "http://10.0.0.7:3000" },
    ]);
  } finally {
    proxyServer.ws = originalWs;
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    resetDockerServiceOverridesForTests();
    resetCdpServiceOverridesForTests();
  }
});

test("handleWebSocketUpgrade CDP bridge injects page-session scripts and filters its own responses", async () => {
  setProxyPrismaMock({
    status: "running",
    internalApiUrl: "http://browsermint-session-running:3000",
  });
  let upstreamServer!: WebSocketServer;
  await new Promise<void>((resolve, reject) => {
    upstreamServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    upstreamServer.once("listening", resolve);
    upstreamServer.once("error", reject);
  });
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;
  const proxyHttpServer = createServer();
  const proxySockets = new Set<Socket>();
  const clientMessages: Array<Record<string, unknown>> = [];
  const upstreamMessages: Array<Record<string, unknown>> = [];
  let client: WebSocket | undefined;
  let upstream: WebSocket | undefined;
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  config.IDLE_PAUSE_ENABLED = false;
  setProxyServiceOverridesForTests({
    getDevtoolsBaseUrl: () => new URL(`http://127.0.0.1:${upstreamPort}/`),
  });
  proxyHttpServer.on("upgrade", (request, socket, head) => {
    handleWebSocketUpgrade(request, socket, head).catch(() => socket.destroy());
  });
  proxyHttpServer.on("connection", (socket) => {
    proxySockets.add(socket);
    socket.on("close", () => proxySockets.delete(socket));
  });

  try {
    await new Promise<void>((resolve) => proxyHttpServer.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxyHttpServer.address() as AddressInfo).port;
    const upstreamConnection = once(upstreamServer, "connection") as Promise<[WebSocket]>;
    const token = encodeURIComponent(makeSessionToken());
    client = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/ws/sessions/session-running/cdp/devtools/page/page-1?token=${token}`
    );
    client.on("message", (data) => {
      clientMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await Promise.race([
      once(client, "open"),
      once(client, "error").then(([err]) => { throw err; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for proxy WebSocket open")), 1000)),
    ]);
    [upstream] = await Promise.race([
      upstreamConnection,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for upstream CDP connection")), 1000)),
    ]);
    upstream.on("message", (data) => {
      upstreamMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    client.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-1", flatten: true },
    }));

    await waitFor(
      () => upstreamMessages.find((msg) => msg.id === 1),
      "expected the agent CDP command to reach upstream"
    );
    upstream.send(JSON.stringify({ id: 1, result: { sessionId: "page-session" } }));

    const injectedCommands = await waitFor(
      () => {
        const commands = upstreamMessages.filter((msg) => msg.sessionId === "page-session" && typeof msg.id === "number");
        return commands.length >= 2 ? commands : undefined;
      },
      "expected bridge-injected CDP commands"
    );
    const injectedMethods = injectedCommands.map((msg) => msg.method);
    assert.equal(injectedMethods[0], "Page.addScriptToEvaluateOnNewDocument");
    assert.equal(injectedMethods.at(-1), "Runtime.evaluate");
    if (config.CAPSOLVER_API_KEY) {
      assert.deepEqual(injectedMethods, [
        "Page.addScriptToEvaluateOnNewDocument",
        "Runtime.addBinding",
        "Page.enable",
        "Runtime.evaluate",
      ]);
    } else {
      assert.deepEqual(injectedMethods, [
        "Page.addScriptToEvaluateOnNewDocument",
        "Runtime.evaluate",
      ]);
    }

    for (const command of injectedCommands) {
      upstream.send(JSON.stringify({ id: command.id, result: {} }));
    }

    const forwardedAttachResponse = await waitFor(
      () => clientMessages.find((msg) => msg.id === 1),
      "expected original attach response to reach the agent"
    );
    assert.deepEqual(forwardedAttachResponse, { id: 1, result: { sessionId: "page-session" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      clientMessages.some((msg) => injectedCommands.some((command) => command.id === msg.id)),
      false
    );

  } finally {
    const closeEvents = [client, upstream]
      .filter((ws): ws is WebSocket => Boolean(ws) && ws.readyState !== WebSocket.CLOSED)
      .map((ws) => Promise.race([
        once(ws, "close"),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]));
    client?.terminate();
    upstream?.terminate();
    for (const ws of upstreamServer.clients) ws.terminate();
    await Promise.allSettled(closeEvents);
    for (const socket of proxySockets) socket.destroy();
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    resetProxyServiceOverridesForTests();
    proxyHttpServer.closeAllConnections();
    await new Promise<void>((resolve) => proxyHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test("handleWebSocketUpgrade proxies non-CDP websocket routes with rewritten upstream paths", async () => {
  const { events, updates } = setProxyPrismaMock({
    status: "running",
    internalApiUrl: "http://10.0.0.5:3000",
  });
  const calls: Array<{ url: string | undefined; target: unknown }> = [];
  const originalWs = proxyServer.ws;
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  config.IDLE_PAUSE_ENABLED = false;
  proxyServer.ws = ((request: IncomingMessage, socket: Duplex, _head: Buffer, options: { target?: unknown }) => {
    calls.push({ url: request.url, target: options.target });
    socket.emit("close");
  }) as typeof proxyServer.ws;

  try {
    const token = encodeURIComponent(makeSessionToken());
    const cases = [
      {
        path: `/ws/sessions/session-running/cast?token=${token}?pageId=page-1&pageIndex=2&tabInfo=true`,
        expectedUrl: "/v1/sessions/cast?pageId=page-1&pageIndex=2&tabInfo=true",
        expectedTarget: "http://10.0.0.5:3000",
      },
      {
        path: `/ws/sessions/session-running/logs?token=${token}`,
        expectedUrl: "/v1/sessions/logs",
        expectedTarget: "http://10.0.0.5:3000",
      },
      {
        path: `/ws/sessions/session-running/pageId?token=${token}`,
        expectedUrl: "/v1/sessions/pageId",
        expectedTarget: "http://10.0.0.5:3000",
      },
      {
        path: `/ws/sessions/session-running/vnc?token=${token}`,
        expectedUrl: "/",
        expectedTarget: "http://10.0.0.5:6080",
      },
    ];

    for (const item of cases) {
      const socket = new TestSocket();
      await handleWebSocketUpgrade(makeWsRequest(item.path), socket, Buffer.alloc(0));
      assert.equal(socket.destroyCalled, false);
    }

    assert.deepEqual(calls, cases.map((item) => ({
      url: item.expectedUrl,
      target: item.expectedTarget,
    })));
    assert.equal(updates.length, cases.length);
    assert.deepEqual(events.map((event) => event.operationType), [
      "ws_cast",
      "ws_logs",
      "ws_pageId",
      "ws_vnc",
    ]);
    assert.equal(events[0].requestPath, "/ws/sessions/session-running/cast?pageId=page-1&pageIndex=2&tabInfo=true");
  } finally {
    proxyServer.ws = originalWs;
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
  }
});
