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

type UserRecord = {
  id: string;
  username: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
};

type SessionRecord = {
  id: string;
  userId: string;
  status: string;
  containerName: string | null;
  internalApiUrl: string | null;
  expiresAt: Date | null;
  tokenIssuedAt: Date | null;
  deletedAt: Date | null;
};

function selectFields<T extends Record<string, unknown>>(record: T, select?: Record<string, unknown>): T | Partial<T> {
  if (!select) return { ...record };
  const result: Partial<T> = {};
  for (const key of Object.keys(select)) {
    result[key as keyof T] = record[key as keyof T];
  }
  return result;
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

function makePrismaMock(users: UserRecord[], sessions: SessionRecord[]) {
  const prisma = {
    user: {
      findUnique: async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        const user = users.find((item) => item.id === args.where.id);
        if (!user) return null;
        return selectFields(user as unknown as Record<string, unknown>, args.select);
      },
    },
    session: {
      findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const session = sessions.find((item) => matchesSessionWhere(item, args.where));
        if (!session) return null;
        return selectFields(session as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<SessionRecord> }) => {
        const session = sessions.find((item) => item.id === args.where.id);
        if (!session) throw new Error("Session not found");
        Object.assign(session, args.data);
        return { ...session };
      },
    },
    $on: () => {},
    $disconnect: async () => {},
    __sessions: sessions,
  };

  return prisma as unknown as AppPrismaClient & { __sessions: SessionRecord[] };
}

const owner: UserRecord = {
  id: "user-owner",
  username: "owner",
  email: "owner@example.com",
  isAdmin: false,
  isActive: true,
};

const otherUser: UserRecord = {
  id: "user-other",
  username: "other",
  email: "other@example.com",
  isAdmin: false,
  isActive: true,
};

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "session-running",
    userId: owner.id,
    status: "running",
    containerName: "browsermint-session-running",
    internalApiUrl: "http://127.0.0.1:3000",
    expiresAt: null,
    tokenIssuedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

async function makeApp(sessions: SessionRecord[]) {
  const prisma = makePrismaMock([owner, otherUser], sessions);
  setPrismaForTests(prisma);
  const app = await createApp({ logger: false, serveStatic: false });
  return { app, prisma };
}

function authCookie(user: UserRecord = owner) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, isAdmin: user.isAdmin },
    config.JWT_SECRET,
    { expiresIn: "24h" }
  );
  return `browsermint_auth=${encodeURIComponent(token)}`;
}

function verifySessionToken(token: string) {
  return jwt.verify(token, config.JWT_SESSION_TOKEN_SECRET) as {
    sub: string;
    sessionId: string;
    type: string;
    iat: number;
    exp: number;
  };
}

test("session token can be issued for owned running and paused sessions", async () => {
  const { app } = await makeApp([
    makeSession({ id: "session-running", status: "running" }),
    makeSession({ id: "session-paused", status: "paused" }),
  ]);
  try {
    for (const id of ["session-running", "session-paused"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/token`,
        headers: { cookie: authCookie() },
      });

      assert.equal(res.statusCode, 200);
      const payload = verifySessionToken(res.json().token);
      assert.equal(payload.sub, owner.id);
      assert.equal(payload.sessionId, id);
      assert.equal(payload.type, "session");
      assert.ok(payload.exp > payload.iat);
    }
  } finally {
    await app.close();
  }
});

test("session token issuance rejects missing auth, cross-user sessions, and stopped sessions", async () => {
  const { app } = await makeApp([
    makeSession({ id: "session-running", status: "running" }),
    makeSession({ id: "session-other", userId: otherUser.id, status: "running" }),
    makeSession({ id: "session-stopped", status: "stopped" }),
  ]);
  try {
    const missingAuth = await app.inject({ method: "POST", url: "/api/sessions/session-running/token" });
    assert.equal(missingAuth.statusCode, 401);

    const crossUser = await app.inject({
      method: "POST",
      url: "/api/sessions/session-other/token",
      headers: { cookie: authCookie() },
    });
    assert.equal(crossUser.statusCode, 404);

    const stopped = await app.inject({
      method: "POST",
      url: "/api/sessions/session-stopped/token",
      headers: { cookie: authCookie() },
    });
    assert.equal(stopped.statusCode, 400);
    assert.equal(stopped.json().error, "Session is not running");
  } finally {
    await app.close();
  }
});

test("refresh-token issues a new token, stores tokenIssuedAt, and revokes older proxy tokens", async () => {
  const originalNow = Date.now;
  const { app, prisma } = await makeApp([
    makeSession({ id: "session-running", status: "running" }),
  ]);

  try {
    Date.now = () => Date.parse("2026-01-01T00:00:00.000Z");
    const first = await app.inject({
      method: "POST",
      url: "/api/sessions/session-running/token",
      headers: { cookie: authCookie() },
    });
    assert.equal(first.statusCode, 200);
    const oldToken = first.json().token as string;
    assert.equal(verifySessionToken(oldToken).iat, Date.parse("2026-01-01T00:00:00.000Z") / 1000);

    Date.now = () => Date.parse("2026-01-01T00:00:03.000Z");
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/sessions/session-running/refresh-token",
      headers: { cookie: authCookie() },
    });
    assert.equal(refreshed.statusCode, 200);

    const newPayload = verifySessionToken(refreshed.json().token);
    assert.equal(newPayload.iat, Date.parse("2026-01-01T00:00:03.000Z") / 1000);
    assert.equal(prisma.__sessions[0].tokenIssuedAt?.toISOString(), "2026-01-01T00:00:03.000Z");
    assert.equal(prisma.__sessions[0].expiresAt?.toISOString(), "2026-06-30T00:00:03.000Z");

    const staleProxyToken = await app.inject({
      method: "GET",
      url: `/api/sessions/session-running/details?token=${encodeURIComponent(oldToken)}`,
    });
    assert.equal(staleProxyToken.statusCode, 401);
    assert.equal(staleProxyToken.json().error, "Invalid token");
  } finally {
    Date.now = originalNow;
    await app.close();
  }
});

test("refresh-token rejects missing sessions and sessions that are not running or paused", async () => {
  const { app } = await makeApp([
    makeSession({ id: "session-error", status: "error" }),
  ]);
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/api/sessions/missing/refresh-token",
      headers: { cookie: authCookie() },
    });
    assert.equal(missing.statusCode, 404);

    const errorSession = await app.inject({
      method: "POST",
      url: "/api/sessions/session-error/refresh-token",
      headers: { cookie: authCookie() },
    });
    assert.equal(errorSession.statusCode, 400);
    assert.equal(errorSession.json().error, "Session is not running");
  } finally {
    await app.close();
  }
});
