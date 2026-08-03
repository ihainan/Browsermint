import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { AppPrismaClient } from "./db/client.js";
import type { SessionEndpoint } from "./services/driver/index.js";

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
  resetDriverOverridesForTests,
  setDriverOverridesForTests,
} = await import("./services/driver/index.js");
const {
  resetCdpServiceOverridesForTests,
  setCdpServiceOverridesForTests,
} = await import("./services/cdp.service.js");
const {
  clearIdleTimer,
  hasIdleTimerForTests,
  scheduleIdlePauseOnStartup,
  wsCountForTests,
  trackWsConnectionForTests,
} = await import("./services/proxy.service.js");

type UserRecord = {
  id: string;
  username: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  maxSessions: number;
};

type SessionRecord = {
  id: string;
  userId: string;
  name: string | null;
  status: string;
  containerId: string | null;
  containerName: string | null;
  internalApiUrl: string | null;
  savedTabs: unknown;
  targetLabels: unknown;
  onlineMs: number;
  runningStartedAt: Date | null;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date | null;
  tokenIssuedAt: Date | null;
  deletedAt: Date | null;
};

const owner: UserRecord = {
  id: "user-owner",
  username: "owner",
  email: "owner@example.com",
  isAdmin: false,
  isActive: true,
  maxSessions: 2,
};

function sessionToken(sessionId: string) {
  return jwt.sign(
    { sub: owner.id, sessionId, type: "session" },
    config.JWT_SESSION_TOKEN_SECRET,
    { expiresIn: "15m" }
  );
}

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "session-1",
    userId: owner.id,
    name: null,
    status: "running",
    containerId: "container-1",
    containerName: "browsermint-session-1",
    internalApiUrl: "http://127.0.0.1:3000",
    savedTabs: null,
    targetLabels: null,
    onlineMs: 0,
    runningStartedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    tokenIssuedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function matchesSessionWhere(session: SessionRecord, where: Record<string, unknown>) {
  if (where.id && session.id !== where.id) return false;
  if (where.userId && session.userId !== where.userId) return false;
  if ("deletedAt" in where && session.deletedAt !== where.deletedAt) return false;
  const status = where.status as { in?: string[] } | string | undefined;
  if (typeof status === "string" && session.status !== status) return false;
  if (status && typeof status === "object" && status.in && !status.in.includes(session.status)) return false;
  return true;
}

function applySessionUpdate(session: SessionRecord, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (key === "onlineMs" && value && typeof value === "object" && "increment" in value) {
      session.onlineMs += Number((value as { increment: number }).increment);
      continue;
    }
    (session as unknown as Record<string, unknown>)[key] = value;
  }
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    lastActiveAt: new Date(session.lastActiveAt),
    expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
    tokenIssuedAt: session.tokenIssuedAt ? new Date(session.tokenIssuedAt) : null,
    deletedAt: session.deletedAt ? new Date(session.deletedAt) : null,
    runningStartedAt: session.runningStartedAt ? new Date(session.runningStartedAt) : null,
    savedTabs: Array.isArray(session.savedTabs) ? [...session.savedTabs] : session.savedTabs,
    targetLabels: session.targetLabels && typeof session.targetLabels === "object"
      ? { ...(session.targetLabels as Record<string, unknown>) } : session.targetLabels,
  };
}

function makePrismaMock(seedSessions: SessionRecord[] = [], userOverrides: Partial<UserRecord> = {}) {
  const sessions = [...seedSessions];
  const user = { ...owner, ...userOverrides };
  let txQueue = Promise.resolve();

  const tx = {
    $executeRaw: async () => undefined,
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === user.id ? { ...user } : null,
    },
    session: {
      count: async (args: { where: Record<string, unknown> }) =>
        sessions.filter((session) => matchesSessionWhere(session, args.where)).length,
      create: async (args: { data: { id: string; userId: string; name: string | null; status: string } }) => {
        const session = makeSession({
          id: args.data.id,
          userId: args.data.userId,
          name: args.data.name,
          status: args.data.status,
          containerId: null,
          containerName: null,
          internalApiUrl: null,
          createdAt: new Date(),
          lastActiveAt: new Date(),
        });
        sessions.push(session);
        return cloneSession(session);
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const session = sessions.find((item) => item.id === args.where.id);
        if (!session) throw new Error("Session not found");
        applySessionUpdate(session, args.data);
        return cloneSession(session);
      },
    },
  };

  const prisma = {
    user: {
      findUnique: async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (args.where.id !== user.id) return null;
        if (args.select) {
          return Object.fromEntries(Object.keys(args.select).map((key) => [key, user[key as keyof UserRecord]]));
        }
        return { ...user };
      },
    },
    session: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        sessions.find((session) => matchesSessionWhere(session, args.where)) ? cloneSession(sessions.find((session) => matchesSessionWhere(session, args.where))!) : null,
      findUnique: async (args: { where: { id: string } }) =>
        sessions.find((session) => session.id === args.where.id) ? cloneSession(sessions.find((session) => session.id === args.where.id)!) : null,
      findMany: async (args: { where?: Record<string, unknown> }) =>
        sessions.filter((session) => !args.where || matchesSessionWhere(session, args.where)).map(cloneSession),
      count: tx.session.count,
      create: tx.session.create,
      update: tx.session.update,
    },
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => {
      const run = txQueue.then(() => callback(tx));
      txQueue = run.then(() => undefined, () => undefined);
      return run;
    },
    $on: () => {},
    $disconnect: async () => {},
    __sessions: sessions,
  };

  return prisma as unknown as AppPrismaClient & { __sessions: SessionRecord[] };
}

function authCookie() {
  const token = jwt.sign(
    { sub: owner.id, username: owner.username, isAdmin: owner.isAdmin },
    config.JWT_SECRET,
    { expiresIn: "24h" }
  );
  return `browsermint_auth=${encodeURIComponent(token)}`;
}

function containerInfo(sessionId: string): SessionEndpoint {
  return {
    containerId: `container-${sessionId}`,
    containerName: `browsermint-${sessionId}`,
    internalApiUrl: `http://127.0.0.1:30${sessionId.slice(-2).replace(/\D/g, "0")}`,
  };
}

async function makeApp(seedSessions: SessionRecord[] = [], userOverrides: Partial<UserRecord> = {}) {
  const calls: string[] = [];
  const prisma = makePrismaMock(seedSessions, userOverrides);
  setPrismaForTests(prisma);
  setDriverOverridesForTests({
    createSession: async (sessionId) => {
      calls.push(`docker:create:${sessionId}`);
      return containerInfo(sessionId);
    },
    waitForReady: async (internalApiUrl) => {
      calls.push(`docker:wait:${internalApiUrl}`);
    },
    startSession: async (_sessionId, containerId) => {
      calls.push(`docker:start:${containerId}`);
      return {
        containerId,
        containerName: `resumed-${containerId}`,
        internalApiUrl: "http://127.0.0.1:3999",
      };
    },
    stopSession: async (_sessionId, containerId) => {
      calls.push(`docker:stop:${containerId}`);
    },
    destroySession: async (_sessionId, containerId) => {
      calls.push(`docker:remove:${containerId}`);
    },
  });
  setCdpServiceOverridesForTests({
    initCdpSession: async (sessionId, internalApiUrl) => {
      calls.push(`cdp:init:${sessionId}:${internalApiUrl}`);
      return true;
    },
    closeBrowserGracefully: async (sessionId) => {
      calls.push(`cdp:close:${sessionId}`);
      return true;
    },
    cleanupCdpSession: (sessionId) => {
      calls.push(`cdp:cleanup:${sessionId}`);
    },
    getOpenPageUrls: async (sessionId) => {
      calls.push(`cdp:tabs:${sessionId}`);
      return ["https://example.com", "https://example.org"];
    },
    openSavedTabs: async (sessionId, urls) => {
      calls.push(`cdp:restore:${sessionId}:${urls.join(",")}`);
    },
    // Labelled variants (page identity across pause/resume)
    getOpenPageEntries: async (sessionId) => {
      calls.push(`cdp:entries:${sessionId}`);
      return [
        { targetId: "T-OLD-1", url: "https://example.com" },
        { targetId: "T-OLD-2", url: "https://example.com" },   // same URL twice on purpose
      ];
    },
    restoreSavedTabs: async (sessionId, tabs) => {
      calls.push(`cdp:restore2:${sessionId}:${tabs.map(t => `${t.label ?? "-"}@${t.url}`).join(",")}`);
      const out: Record<string, string> = {};
      tabs.forEach((t, i) => { if (t.label) out[t.label] = `T-NEW-${i + 1}`; });
      return out;
    },
  });

  const app = await createApp({ logger: false, serveStatic: false });
  return { app, prisma, calls };
}

async function closeApp(app: Awaited<ReturnType<typeof createApp>>) {
  await app.close();
  resetDriverOverridesForTests();
  resetCdpServiceOverridesForTests();
}

test("POST /api/sessions creates a running browser session with mocked Docker and CDP", async () => {
  const { app, prisma, calls } = await makeApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: { name: "Research" },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().session.status, "running");
    assert.equal(res.json().session.name, "Research");
    assert.ok(res.json().session.containerId);
    assert.equal(prisma.__sessions.length, 1);
    assert.ok(calls.some((call) => call.startsWith("docker:create:")));
    assert.ok(calls.some((call) => call.startsWith("docker:wait:")));
    assert.ok(calls.some((call) => call.startsWith("cdp:init:")));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions marks failed creates as error and removes the started container", async () => {
  const { app, prisma, calls } = await makeApp();
  setDriverOverridesForTests({
    createSession: async (sessionId) => {
      calls.push(`docker:create:${sessionId}`);
      return containerInfo(sessionId);
    },
    waitForReady: async () => {
      calls.push("docker:wait:fail");
      throw new Error("not ready");
    },
    destroySession: async (_sessionId, containerId) => {
      calls.push(`docker:remove:${containerId}`);
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: {},
    });

    assert.equal(res.statusCode, 500);
    assert.equal(prisma.__sessions[0].status, "error");
    assert.ok(calls.some((call) => call.startsWith("docker:remove:")));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions fails and cleans up when initial CDP initialization returns false", async () => {
  const { app, prisma, calls } = await makeApp();
  setCdpServiceOverridesForTests({
    initCdpSession: async (sessionId, internalApiUrl) => {
      calls.push(`cdp:init:false:${sessionId}:${internalApiUrl}`);
      return false;
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: {},
    });

    assert.equal(res.statusCode, 500);
    assert.equal(prisma.__sessions[0].status, "error");
    assert.ok(calls.some((call) => call.startsWith("cdp:init:false:")));
    assert.ok(calls.some((call) => call.startsWith("docker:remove:")));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions cleans up CDP and container when deleted during creation", async () => {
  const { app, prisma, calls } = await makeApp();
  setCdpServiceOverridesForTests({
    initCdpSession: async (sessionId, internalApiUrl) => {
      calls.push(`cdp:init:delete:${sessionId}:${internalApiUrl}`);
      prisma.__sessions[0].deletedAt = new Date();
      return true;
    },
    cleanupCdpSession: (sessionId) => {
      calls.push(`cdp:cleanup:${sessionId}`);
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "Session was deleted during creation");
    assert.equal(prisma.__sessions[0].deletedAt instanceof Date, true);
    assert.ok(calls.some((call) => call.startsWith("cdp:init:delete:")));
    assert.ok(calls.some((call) => call.startsWith("cdp:cleanup:")));
    assert.ok(calls.some((call) => call.startsWith("docker:remove:")));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions counts creating, running, and paused sessions toward maxSessions", async () => {
  const { app, calls } = await makeApp([
    makeSession({ id: "session-creating", status: "creating" }),
    makeSession({ id: "session-running", status: "running" }),
    makeSession({ id: "session-paused", status: "paused" }),
  ], { maxSessions: 3 });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: {},
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, "Session limit reached (max 3)");
    assert.equal(calls.some((call) => call.startsWith("docker:")), false);
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions treats maxSessions 0 as unlimited", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({ id: "session-creating", status: "creating" }),
    makeSession({ id: "session-running", status: "running" }),
    makeSession({ id: "session-paused", status: "paused" }),
  ], { maxSessions: 0 });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: { name: "unlimited" },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(prisma.__sessions.length, 4);
    assert.ok(calls.some((call) => call.startsWith("docker:create:")));
    assert.ok(calls.some((call) => call.startsWith("cdp:init:")));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions serializes concurrent creates so maxSessions is not exceeded", async () => {
  const { app, prisma, calls } = await makeApp([], { maxSessions: 1 });
  try {
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: authCookie() }, payload: { name: "one" } }),
      app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: authCookie() }, payload: { name: "two" } }),
    ]);

    assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 429]);
    assert.equal(prisma.__sessions.filter((session) => session.deletedAt === null && ["creating", "running", "paused"].includes(session.status)).length, 1);
    assert.equal(calls.filter((call) => call.startsWith("docker:create:")).length, 1);
  } finally {
    await closeApp(app);
  }
});

test("GET /api/sessions lists only owned active sessions and get rejects cross-user sessions", async () => {
  const { app } = await makeApp([
    makeSession({ id: "owned-active", userId: owner.id, deletedAt: null }),
    makeSession({ id: "owned-deleted", userId: owner.id, deletedAt: new Date() }),
    makeSession({ id: "other-active", userId: "user-other", deletedAt: null }),
  ]);
  try {
    const list = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
    });

    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().sessions.map((session: SessionRecord) => session.id), ["owned-active"]);

    const owned = await app.inject({
      method: "GET",
      url: "/api/sessions/owned-active",
      headers: { cookie: authCookie() },
    });
    assert.equal(owned.statusCode, 200);
    assert.equal(owned.json().session.id, "owned-active");

    const crossUser = await app.inject({
      method: "GET",
      url: "/api/sessions/other-active",
      headers: { cookie: authCookie() },
    });
    assert.equal(crossUser.statusCode, 404);
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/stop saves tabs, stops the container, and accumulates online time", async () => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-running",
      status: "running",
      containerId: "container-running",
      onlineMs: 500,
      runningStartedAt: new Date(7_000),
    }),
  ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-running/stop",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    const session = prisma.__sessions[0];
    assert.equal(session.status, "stopped");
    assert.equal(session.containerId, "container-running");
    assert.equal(session.containerName, "browsermint-session-1");
    assert.equal(session.internalApiUrl, "http://127.0.0.1:3000");
    assert.deepEqual(session.savedTabs, ["https://example.com", "https://example.org"]);
    assert.equal(session.onlineMs, 3_500);
    assert.equal(session.runningStartedAt, null);
    assert.deepEqual(calls.filter((call) => call.startsWith("cdp:")), [
      "cdp:tabs:session-running",
      "cdp:close:session-running",
      "cdp:cleanup:session-running",
    ]);
    assert.ok(calls.includes("docker:stop:container-running"));
  } finally {
    Date.now = originalNow;
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/stop rejects sessions that are not running or paused", async () => {
  const { app, calls } = await makeApp([
    makeSession({ id: "session-stopped", status: "stopped" }),
  ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-stopped/stop",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "Session is not running");
    assert.equal(calls.some((call) => call.startsWith("docker:")), false);
    assert.equal(calls.some((call) => call.startsWith("cdp:")), false);
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/stop handles paused sessions without CDP tab inspection", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-paused",
      status: "paused",
      containerId: "container-paused",
      onlineMs: 10_000,
      runningStartedAt: null,
    }),
  ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-paused/stop",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    const session = prisma.__sessions[0];
    assert.equal(session.status, "stopped");
    assert.equal(session.onlineMs, 10_000);
    assert.equal(session.savedTabs, null);
    assert.ok(calls.includes("cdp:cleanup:session-paused"));
    assert.ok(calls.includes("docker:stop:container-paused"));
    assert.equal(calls.some((call) => call.startsWith("cdp:tabs:")), false);
    assert.equal(calls.some((call) => call.startsWith("cdp:close:")), false);
  } finally {
    await closeApp(app);
  }
});

test("DELETE /api/sessions/:id marks deleted, clears idle timers, updates online time, and removes the container", async () => {
  const originalNow = Date.now;
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  const originalIdlePauseTimeout = config.IDLE_PAUSE_TIMEOUT_MS;
  Date.now = () => 10_000;
  config.IDLE_PAUSE_ENABLED = true;
  config.IDLE_PAUSE_TIMEOUT_MS = 60_000;
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-delete",
      status: "running",
      containerId: "container-delete",
      runningStartedAt: new Date(Date.now() - 2_000),
    }),
  ]);
  try {
    scheduleIdlePauseOnStartup("session-delete");
    assert.equal(hasIdleTimerForTests("session-delete"), true);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/sessions/session-delete",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true });
    const session = prisma.__sessions[0];
    assert.equal(session.status, "stopped");
    assert.ok(session.deletedAt instanceof Date);
    assert.equal(session.onlineMs, 2_000);
    assert.equal(session.runningStartedAt, null);
    assert.equal(hasIdleTimerForTests("session-delete"), false);
    assert.ok(calls.includes("cdp:close:session-delete"));
    assert.ok(calls.includes("cdp:cleanup:session-delete"));
    assert.ok(calls.includes("docker:remove:container-delete"));
  } finally {
    Date.now = originalNow;
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    config.IDLE_PAUSE_TIMEOUT_MS = originalIdlePauseTimeout;
    clearIdleTimer("session-delete");
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/start enforces maxSessions before starting Docker work", async () => {
  const { app, calls } = await makeApp([
    makeSession({ id: "session-stopped", status: "stopped" }),
    makeSession({ id: "session-running", status: "running" }),
    makeSession({ id: "session-paused", status: "paused" }),
  ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-stopped/start",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, "Session limit reached (max 2)");
    assert.equal(calls.some((call) => call.startsWith("docker:")), false);
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/start serializes concurrent starts so maxSessions is not exceeded", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({ id: "session-stopped-1", status: "stopped", containerId: "container-stopped-1" }),
    makeSession({ id: "session-stopped-2", status: "stopped", containerId: "container-stopped-2" }),
  ], { maxSessions: 1 });
  try {
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/sessions/session-stopped-1/start", headers: { cookie: authCookie() } }),
      app.inject({ method: "POST", url: "/api/sessions/session-stopped-2/start", headers: { cookie: authCookie() } }),
    ]);

    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 429]);
    assert.equal(prisma.__sessions.filter((session) => session.status === "running").length, 1);
    assert.equal(calls.filter((call) => call.startsWith("docker:start:")).length, 1);
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/start restarts an existing container and restores saved tabs", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-stopped",
      status: "stopped",
      containerId: "container-stopped",
      containerName: "old-container",
      internalApiUrl: "http://127.0.0.1:3000",
      savedTabs: ["https://example.com"],
      runningStartedAt: null,
    }),
  ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-stopped/start",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    const session = prisma.__sessions[0];
    assert.equal(session.status, "running");
    assert.equal(session.containerId, "container-stopped");
    assert.equal(session.containerName, "resumed-container-stopped");
    assert.equal(session.internalApiUrl, "http://127.0.0.1:3999");
    assert.equal(Array.isArray(session.savedTabs), false);
    assert.ok(session.runningStartedAt instanceof Date);
    assert.ok(calls.includes("docker:start:container-stopped"));
    assert.ok(calls.includes("docker:wait:http://127.0.0.1:3999"));
    assert.ok(calls.includes("cdp:init:session-stopped:http://127.0.0.1:3999"));
    assert.ok(calls.includes("cdp:restore:session-stopped:https://example.com"));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/start falls back to a fresh container on stale Docker network 404", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-stale",
      status: "stopped",
      containerId: "container-stale",
      containerName: "old-container",
      internalApiUrl: "http://127.0.0.1:3000",
      runningStartedAt: null,
    }),
  ]);
  setDriverOverridesForTests({
    startSession: async (_sessionId, containerId) => {
      calls.push(`docker:start:404:${containerId}`);
      throw Object.assign(new Error("stale network"), { statusCode: 404 });
    },
    destroySession: async (_sessionId, containerId) => {
      calls.push(`docker:remove:${containerId}`);
    },
    createSession: async (sessionId) => {
      calls.push(`docker:create:fallback:${sessionId}`);
      return {
        containerId: `fresh-${sessionId}`,
        containerName: `fresh-${sessionId}`,
        internalApiUrl: "http://127.0.0.1:3888",
      };
    },
    waitForReady: async (internalApiUrl) => {
      calls.push(`docker:wait:${internalApiUrl}`);
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-stale/start",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    const session = prisma.__sessions[0];
    assert.equal(session.status, "running");
    assert.equal(session.containerId, "fresh-session-stale");
    assert.equal(session.containerName, "fresh-session-stale");
    assert.equal(session.internalApiUrl, "http://127.0.0.1:3888");
    assert.ok(calls.includes("docker:start:404:container-stale"));
    assert.ok(calls.includes("docker:remove:container-stale"));
    assert.ok(calls.includes("docker:create:fallback:session-stale"));
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/start removes container and cleans up CDP when deleted during startup", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-deleted-start",
      status: "stopped",
      containerId: null,
      containerName: null,
      internalApiUrl: null,
      runningStartedAt: null,
    }),
  ]);
  setCdpServiceOverridesForTests({
    initCdpSession: async (sessionId, internalApiUrl) => {
      calls.push(`cdp:init:delete:${sessionId}:${internalApiUrl}`);
      prisma.__sessions[0].deletedAt = new Date();
      return true;
    },
    cleanupCdpSession: (sessionId) => {
      calls.push(`cdp:cleanup:${sessionId}`);
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-deleted-start/start",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "Session was deleted during startup");
    assert.equal(prisma.__sessions[0].deletedAt instanceof Date, true);
    assert.ok(calls.includes("docker:create:session-deleted-start"));
    assert.ok(calls.includes("docker:remove:container-session-deleted-start"));
    assert.ok(calls.includes("cdp:cleanup:session-deleted-start"));
    assert.equal(calls.some((call) => call === "docker:stop:container-session-deleted-start"), false);
  } finally {
    await closeApp(app);
  }
});

test("POST /api/sessions/:id/start recovers once from CDP init failure and fails if fresh CDP init also fails", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-cdp-fail",
      status: "stopped",
      containerId: "container-cdp-fail",
      containerName: "old-container",
      internalApiUrl: "http://127.0.0.1:3000",
      runningStartedAt: null,
    }),
  ]);
  setCdpServiceOverridesForTests({
    initCdpSession: async (sessionId, internalApiUrl) => {
      calls.push(`cdp:init:false:${sessionId}:${internalApiUrl}`);
      return false;
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-cdp-fail/start",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 500);
    const session = prisma.__sessions[0];
    assert.equal(session.status, "error");
    assert.ok(calls.includes("docker:start:container-cdp-fail"));
    assert.ok(calls.includes("docker:remove:container-cdp-fail"));
    assert.ok(calls.includes("docker:create:session-cdp-fail"));
    assert.ok(calls.some((call) => call.startsWith("docker:remove:container-session-cdp-fail")));
    assert.equal(calls.filter((call) => call.startsWith("cdp:init:false:")).length, 2);
  } finally {
    await closeApp(app);
  }
});

// ── WS connection accounting (multi-viewer idle-pause correctness) ───────────
// Regression for the "page view" work: several viewers may watch one session at
// the same time (two browser windows / desktop + phone). The counter must track
// every live connection, and a single socket must never release twice.

test("multiple viewers accumulate the WS count and only the last disconnect arms idle-pause", () => {
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  const originalIdlePauseTimeout = config.IDLE_PAUSE_TIMEOUT_MS;
  config.IDLE_PAUSE_ENABLED = true;
  config.IDLE_PAUSE_TIMEOUT_MS = 60_000;
  const sid = "session-ws-count";
  try {
    const releaseA = trackWsConnectionForTests(sid);
    assert.equal(wsCountForTests(sid), 1);
    const releaseB = trackWsConnectionForTests(sid);
    // Second viewer must add to the count, not replace it.
    assert.equal(wsCountForTests(sid), 2);
    assert.equal(hasIdleTimerForTests(sid), false);

    releaseA();
    // One viewer is still watching → no idle timer, count back to 1.
    assert.equal(wsCountForTests(sid), 1);
    assert.equal(hasIdleTimerForTests(sid), false);

    releaseB();
    assert.equal(wsCountForTests(sid), 0);
    assert.equal(hasIdleTimerForTests(sid), true);
  } finally {
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    config.IDLE_PAUSE_TIMEOUT_MS = originalIdlePauseTimeout;
    clearIdleTimer(sid);
  }
});

test("a socket that fires both error and close releases its WS slot only once", () => {
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  config.IDLE_PAUSE_ENABLED = true;
  const sid = "session-ws-double-release";
  try {
    const releaseA = trackWsConnectionForTests(sid);
    const releaseB = trackWsConnectionForTests(sid);
    assert.equal(wsCountForTests(sid), 2);

    releaseA();       // "error"
    releaseA();       // followed by "close" — must be a no-op
    assert.equal(wsCountForTests(sid), 1);
    assert.equal(hasIdleTimerForTests(sid), false);

    releaseB();
    assert.equal(wsCountForTests(sid), 0);
  } finally {
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    clearIdleTimer(sid);
  }
});

// ── Page identity across pause/resume ────────────────────────────────────────
// Embedders (the ZGCAI chat workspace) address pages by their own id. A plain
// URL list cannot survive duplicate URLs or redirects, so pause must persist the
// label with each tab and resume must publish the new label→target mapping.

test("target labels: pause saves labelled tabs and resume republishes the new mapping", async () => {
  const originalIdlePauseEnabled = config.IDLE_PAUSE_ENABLED;
  const originalIdlePauseTimeout = config.IDLE_PAUSE_TIMEOUT_MS;
  config.IDLE_PAUSE_ENABLED = true;
  config.IDLE_PAUSE_TIMEOUT_MS = 1;
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-labels",
      status: "running",
      containerId: "container-labels",
      internalApiUrl: "http://127.0.0.1:3000",
    }),
  ]);
  try {
    // The platform labels its two pages, which happen to share a URL.
    prisma.__sessions[0].targetLabels = { bp_one: "T-OLD-1", bp_two: "T-OLD-2" };
    const token = sessionToken("session-labels");

    const put = await app.inject({
      method: "PUT",
      url: `/api/sessions/session-labels/target-labels?token=${encodeURIComponent(token)}`,
      payload: { label: "bp_three", targetId: "T-OLD-3" },
    });
    assert.equal(put.statusCode, 200);
    assert.equal((prisma.__sessions[0].targetLabels as Record<string, string>).bp_three, "T-OLD-3");

    const got = await app.inject({
      method: "GET",
      url: `/api/sessions/session-labels/target-labels?token=${encodeURIComponent(token)}`,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().labels["bp_one"], "T-OLD-1");
  } finally {
    config.IDLE_PAUSE_ENABLED = originalIdlePauseEnabled;
    config.IDLE_PAUSE_TIMEOUT_MS = originalIdlePauseTimeout;
    clearIdleTimer("session-labels");
    await closeApp(app);
  }
});

// ── 暂停时保存标签页：读不到 ≠ 一个都没开（2026-08-03 事故）────────────────────
// 后端重启之后没有 CDP 会话，getOpenPageEntries 当时返回 []，idle-pause 就把「没有
// 标签页」写了上去，恢复出来的浏览器是空的——用户开着的 13 个页面全没了。
test("暂停时读不到标签页 → 保留上一次的快照，绝不写空", async () => {
  const { app, prisma } = await makeApp([
    makeSession({
      id: "s-keep", status: "running", containerId: "c-keep",
      savedTabs: [{ label: "p1", url: "https://example.com/keep" }],
    }),
  ]);
  const { setCdpServiceOverridesForTests, resetCdpServiceOverridesForTests } =
    await import("./services/cdp.service.js");
  const { setDriverOverridesForTests, resetDriverOverridesForTests } =
    await import("./services/driver/index.js");
  const { pauseSessionIfIdle } = await import("./services/proxy.service.js");
  try {
    // 暂停即销毁工作负载（K8s 语义）——只有这条路径才需要保存标签页
    setDriverOverridesForTests({ pauseReleasesWorkload: true, pauseSession: async () => {} });
    setCdpServiceOverridesForTests({ getOpenPageEntries: async () => null });
    await pauseSessionIfIdle("s-keep");
    const session = prisma.__sessions[0];
    assert.deepEqual(session.savedTabs, [{ label: "p1", url: "https://example.com/keep" }],
      "读不到就该原样保留，写空等于把用户的页面全丢了");
  } finally {
    resetCdpServiceOverridesForTests();
    resetDriverOverridesForTests?.();
    await closeApp(app);
  }
});

test("暂停时读得到标签页 → 覆盖成最新的一份", async () => {
  const { app, prisma } = await makeApp([
    makeSession({
      id: "s-fresh", status: "running", containerId: "c-fresh",
      savedTabs: [{ label: "old", url: "https://example.com/old" }],
    }),
  ]);
  const { setCdpServiceOverridesForTests, resetCdpServiceOverridesForTests } =
    await import("./services/cdp.service.js");
  const { pauseSessionIfIdle } = await import("./services/proxy.service.js");
  try {
    setDriverOverridesForTests({ pauseReleasesWorkload: true, pauseSession: async () => {} });
    setCdpServiceOverridesForTests({
      getOpenPageEntries: async () => [{ targetId: "T1", url: "https://example.com/new" }],
    });
    await pauseSessionIfIdle("s-fresh");
    assert.deepEqual(prisma.__sessions[0].savedTabs, [{ label: undefined, url: "https://example.com/new" }]);
  } finally {
    resetCdpServiceOverridesForTests();
    resetDriverOverridesForTests?.();
    await closeApp(app);
  }
});

test("运行期间定期快照：读得到就写，读不到什么都不动", async () => {
  const { app, prisma } = await makeApp([
    makeSession({
      id: "s-snap", status: "running", containerId: "c-snap",
      savedTabs: [{ label: "prev", url: "https://example.com/prev" }],
    }),
  ]);
  const { setCdpServiceOverridesForTests, resetCdpServiceOverridesForTests } =
    await import("./services/cdp.service.js");
  const { snapshotOpenTabs } = await import("./services/proxy.service.js");
  try {
    setCdpServiceOverridesForTests({ getOpenPageEntries: async () => null });
    assert.equal(await snapshotOpenTabs("s-snap"), false);
    assert.deepEqual(prisma.__sessions[0].savedTabs, [{ label: "prev", url: "https://example.com/prev" }]);

    setCdpServiceOverridesForTests({
      getOpenPageEntries: async () => [{ targetId: "T9", url: "https://example.com/live" }],
    });
    assert.equal(await snapshotOpenTabs("s-snap"), true);
    assert.deepEqual(prisma.__sessions[0].savedTabs, [{ label: undefined, url: "https://example.com/live" }]);
  } finally {
    resetCdpServiceOverridesForTests();
    resetDriverOverridesForTests?.();
    await closeApp(app);
  }
});
