import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import jwt from "jsonwebtoken";
import type { IncomingMessage } from "node:http";
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
  rewriteUpstreamWebSocketUrl,
  sanitizeRequestPath,
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

function setProxyPrismaMock(session: {
  id?: string;
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
      findFirst: async (args?: { where?: { user?: { isActive?: boolean } } }) => {
        if (!session) return null;
        if (args?.where?.user?.isActive === true && session.userActive === false) return null;
        return {
          id: session.id ?? "session-running",
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

test("handleWebSocketUpgrade rejects missing, invalid, wrong-session, and superseded tokens", async () => {
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
