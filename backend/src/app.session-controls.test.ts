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

function makePrismaMock() {
  const events: unknown[] = [];
  const prisma = {
    session: {
      findFirst: async (args: { where: { id?: string; userId?: string; deletedAt?: null; status?: { in: string[] } }; select?: Record<string, unknown> }) => {
        if (args.where.id !== "session-running") return null;
        if (args.where.userId !== owner.id) return null;
        const session = {
          id: "session-running",
          containerName: "browsermint-session-running",
          internalApiUrl: "http://127.0.0.1:3000",
          tokenIssuedAt: null,
        };
        if (!args.select) return session;
        return Object.fromEntries(Object.keys(args.select).map((key) => [key, session[key as keyof typeof session]]));
      },
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

async function makeApp() {
  const prisma = makePrismaMock();
  const calls: Array<{ sessionId: string; method: string; params: Record<string, unknown>; targetId?: string }> = [];
  setPrismaForTests(prisma);
  setCdpServiceOverridesForTests({
    executeCdpCommand: async (sessionId, method, params = {}, targetId) => {
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
    },
  });
  const app = await createApp({ logger: false, serveStatic: false });
  return { app, prisma, calls };
}

async function closeApp(app: Awaited<ReturnType<typeof createApp>>) {
  await app.close();
  resetCdpServiceOverridesForTests();
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
    assert.deepEqual(calls.slice(-2), [
      { sessionId: "session-running", method: "Page.getNavigationHistory", params: {}, targetId: "page-1" },
      { sessionId: "session-running", method: "Page.navigateToHistoryEntry", params: { entryId: 10 }, targetId: "page-1" },
    ]);

    const forward = await app.inject({
      method: "POST",
      url: `/api/sessions/session-running/go-forward?token=${encodeURIComponent(token)}`,
      payload: { targetId: "page-1" },
    });
    assert.equal(forward.statusCode, 200);
    assert.deepEqual(calls.slice(-2), [
      { sessionId: "session-running", method: "Page.getNavigationHistory", params: {}, targetId: "page-1" },
      { sessionId: "session-running", method: "Page.navigateToHistoryEntry", params: { entryId: 12 }, targetId: "page-1" },
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
