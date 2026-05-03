import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { AppPrismaClient } from "./db/client.js";
import type { ContainerInfo } from "./services/docker.service.js";

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
  resetDockerServiceOverridesForTests,
  setDockerServiceOverridesForTests,
} = await import("./services/docker.service.js");
const {
  resetCdpServiceOverridesForTests,
  setCdpServiceOverridesForTests,
} = await import("./services/cdp.service.js");

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
  };
}

function makePrismaMock(seedSessions: SessionRecord[] = []) {
  const sessions = [...seedSessions];

  const tx = {
    $executeRaw: async () => undefined,
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === owner.id ? { ...owner } : null,
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
        if (args.where.id !== owner.id) return null;
        if (args.select) {
          return Object.fromEntries(Object.keys(args.select).map((key) => [key, owner[key as keyof UserRecord]]));
        }
        return { ...owner };
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
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
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

function containerInfo(sessionId: string): ContainerInfo {
  return {
    containerId: `container-${sessionId}`,
    containerName: `browsermint-${sessionId}`,
    internalApiUrl: `http://127.0.0.1:30${sessionId.slice(-2).replace(/\D/g, "0")}`,
  };
}

async function makeApp(seedSessions: SessionRecord[] = []) {
  const calls: string[] = [];
  const prisma = makePrismaMock(seedSessions);
  setPrismaForTests(prisma);
  setDockerServiceOverridesForTests({
    createAndStartContainer: async (sessionId) => {
      calls.push(`docker:create:${sessionId}`);
      return containerInfo(sessionId);
    },
    waitForContainerReady: async (internalApiUrl) => {
      calls.push(`docker:wait:${internalApiUrl}`);
    },
    startExistingContainer: async (containerId) => {
      calls.push(`docker:start:${containerId}`);
      return {
        containerId,
        containerName: `resumed-${containerId}`,
        internalApiUrl: "http://127.0.0.1:3999",
      };
    },
    stopContainer: async (containerId) => {
      calls.push(`docker:stop:${containerId}`);
    },
    stopAndRemoveContainer: async (containerId) => {
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
  });

  const app = await createApp({ logger: false, serveStatic: false });
  return { app, prisma, calls };
}

async function closeApp(app: Awaited<ReturnType<typeof createApp>>) {
  await app.close();
  resetDockerServiceOverridesForTests();
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
  setDockerServiceOverridesForTests({
    createAndStartContainer: async (sessionId) => {
      calls.push(`docker:create:${sessionId}`);
      return containerInfo(sessionId);
    },
    waitForContainerReady: async () => {
      calls.push("docker:wait:fail");
      throw new Error("not ready");
    },
    stopAndRemoveContainer: async (containerId) => {
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

test("POST /api/sessions enforces maxSessions before starting Docker work", async () => {
  const { app, calls } = await makeApp([
    makeSession({ id: "session-running", status: "running" }),
    makeSession({ id: "session-paused", status: "paused" }),
  ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie() },
      payload: {},
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, "Session limit reached (max 2)");
    assert.equal(calls.some((call) => call.startsWith("docker:")), false);
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

test("DELETE /api/sessions/:id marks deleted, removes the container, and returns success", async () => {
  const { app, prisma, calls } = await makeApp([
    makeSession({
      id: "session-delete",
      status: "running",
      containerId: "container-delete",
      runningStartedAt: new Date(Date.now() - 2_000),
    }),
  ]);
  try {
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
    assert.equal(session.runningStartedAt, null);
    assert.ok(calls.includes("cdp:close:session-delete"));
    assert.ok(calls.includes("cdp:cleanup:session-delete"));
    assert.ok(calls.includes("docker:remove:container-delete"));
  } finally {
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
  setDockerServiceOverridesForTests({
    startExistingContainer: async (containerId) => {
      calls.push(`docker:start:404:${containerId}`);
      throw Object.assign(new Error("stale network"), { statusCode: 404 });
    },
    stopAndRemoveContainer: async (containerId) => {
      calls.push(`docker:remove:${containerId}`);
    },
    createAndStartContainer: async (sessionId) => {
      calls.push(`docker:create:fallback:${sessionId}`);
      return {
        containerId: `fresh-${sessionId}`,
        containerName: `fresh-${sessionId}`,
        internalApiUrl: "http://127.0.0.1:3888",
      };
    },
    waitForContainerReady: async (internalApiUrl) => {
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
