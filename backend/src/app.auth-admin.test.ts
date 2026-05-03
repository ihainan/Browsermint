import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
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
  passwordHash: string;
  isAdmin: boolean;
  isActive: boolean;
  maxSessions: number;
  createdAt: Date;
};

type SessionRecord = {
  id: string;
  userId: string;
  name: string | null;
  status: string;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date | null;
  deletedAt: Date | null;
  eventCount: number;
};

function applySelect(user: UserRecord, select?: Record<string, unknown>, sessions: SessionRecord[] = []) {
  if (!select) return { ...user };
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (key === "_count") {
      result._count = {
        sessions: sessions.filter((s) => s.userId === user.id && s.deletedAt === null).length,
      };
    } else {
      result[key] = user[key as keyof UserRecord];
    }
  }
  return result;
}

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    name: null,
    status: "running",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    deletedAt: null,
    eventCount: 0,
    ...overrides,
  };
}

function applySessionSelect(session: SessionRecord, users: UserRecord[], select?: Record<string, unknown>) {
  if (!select) return { ...session };
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (key === "user") {
      const user = users.find((item) => item.id === session.userId);
      result.user = user ? { id: user.id, username: user.username, email: user.email } : null;
    } else if (key === "_count") {
      result._count = { events: session.eventCount };
    } else {
      result[key] = session[key as keyof SessionRecord];
    }
  }
  return result;
}

function makePrismaMock(seedUsers: UserRecord[] = [], seedSessions: SessionRecord[] = []) {
  const users = [...seedUsers];
  const sessions: SessionRecord[] = [...seedSessions];
  let nextId = users.length + 1;

  const prisma = {
    user: {
      count: async (args?: { where?: { isAdmin?: boolean } }) => {
        if (typeof args?.where?.isAdmin === "boolean") {
          return users.filter((user) => user.isAdmin === args.where!.isAdmin).length;
        }
        return users.length;
      },
      findFirst: async (args: { where?: { OR?: Array<{ email?: string; username?: string }> } }) => {
        const or = args.where?.OR ?? [];
        return users.find((user) =>
          or.some((clause) =>
            (clause.email && user.email === clause.email) ||
            (clause.username && user.username === clause.username)
          )
        ) ?? null;
      },
      findUnique: async (args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) => {
        const user = users.find((item) =>
          (args.where.id && item.id === args.where.id) ||
          (args.where.email && item.email === args.where.email)
        );
        if (!user) return null;
        return applySelect(user, args.select, sessions);
      },
      findMany: async (args?: { select?: Record<string, unknown> }) =>
        users.map((user) => applySelect(user, args?.select, sessions)),
      create: async (args: { data: Omit<UserRecord, "id" | "createdAt" | "isActive"> & { isActive?: boolean }; select?: Record<string, unknown> }) => {
        const user: UserRecord = {
          id: `user-${nextId++}`,
          username: args.data.username,
          email: args.data.email,
          passwordHash: args.data.passwordHash,
          isAdmin: args.data.isAdmin,
          isActive: args.data.isActive ?? true,
          maxSessions: args.data.maxSessions,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        users.push(user);
        return applySelect(user, args.select, sessions);
      },
      update: async (args: { where: { id: string }; data: Partial<UserRecord>; select?: Record<string, unknown> }) => {
        const user = users.find((item) => item.id === args.where.id);
        if (!user) throw new Error("User not found");
        Object.assign(user, args.data);
        return applySelect(user, args.select, sessions);
      },
      delete: async (args: { where: { id: string } }) => {
        const index = users.findIndex((item) => item.id === args.where.id);
        if (index === -1) throw new Error("User not found");
        return users.splice(index, 1)[0];
      },
    },
    session: {
      findMany: async (args?: { where?: { userId?: string; deletedAt?: null }; select?: Record<string, unknown>; take?: number }) => {
        const filtered = sessions
          .filter((session) => !args?.where?.userId || session.userId === args.where.userId)
          .filter((session) => !("deletedAt" in (args?.where ?? {})) || session.deletedAt === args!.where!.deletedAt);
        return filtered.slice(0, args?.take).map((session) => applySessionSelect(session, users, args?.select));
      },
    },
    $on: () => {},
    $disconnect: async () => {},
    __users: users,
    __sessions: sessions,
  };

  return prisma as unknown as AppPrismaClient & { __users: UserRecord[]; __sessions: SessionRecord[] };
}

async function makeApp(prisma = makePrismaMock()) {
  setPrismaForTests(prisma);
  const app = await createApp({ logger: false, serveStatic: false });
  return { app, prisma };
}

function authCookie(res: { headers: Record<string, string | string[] | undefined> }) {
  const raw = res.headers["set-cookie"];
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(cookie, "expected auth response to set a cookie");
  return cookie.split(";")[0];
}

async function register(app: Awaited<ReturnType<typeof createApp>>, username: string, email: string, password = "Password123!") {
  return app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, email, password },
  });
}

test("createApp exposes health without running startup lifecycle tasks", async () => {
  const { app } = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  } finally {
    await app.close();
  }
});

test("auth config reflects registration mode", async () => {
  const originalMode = config.REGISTRATION_MODE;
  const { app } = await makeApp();
  try {
    config.REGISTRATION_MODE = "disabled";
    const disabled = await app.inject({ method: "GET", url: "/api/auth/config" });
    assert.equal(disabled.statusCode, 200);
    assert.deepEqual(disabled.json(), { registrationEnabled: false });

    config.REGISTRATION_MODE = "open";
    const open = await app.inject({ method: "GET", url: "/api/auth/config" });
    assert.equal(open.statusCode, 200);
    assert.deepEqual(open.json(), { registrationEnabled: true });
  } finally {
    config.REGISTRATION_MODE = originalMode;
    await app.close();
  }
});

test("registration creates the first user as admin and supports /me from auth cookie", async () => {
  const { app } = await makeApp();
  try {
    const res = await register(app, "owner", "owner@example.com");

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().user.isAdmin, true);
    assert.equal(res.json().user.maxSessions, 0);
    assert.match(String(res.headers["set-cookie"]), /HttpOnly/);
    assert.match(String(res.headers["set-cookie"]), /SameSite=Lax/);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: authCookie(res) },
    });

    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, "owner@example.com");
  } finally {
    await app.close();
  }
});

test("registration disabled returns 403 without creating a user", async () => {
  const originalMode = config.REGISTRATION_MODE;
  const { app, prisma } = await makeApp();
  try {
    config.REGISTRATION_MODE = "disabled";
    const res = await register(app, "blocked", "blocked@example.com");

    assert.equal(res.statusCode, 403);
    assert.equal(prisma.__users.length, 0);
  } finally {
    config.REGISTRATION_MODE = originalMode;
    await app.close();
  }
});

test("duplicate registration and invalid login are rejected", async () => {
  const { app } = await makeApp();
  try {
    assert.equal((await register(app, "owner", "owner@example.com")).statusCode, 201);
    assert.equal((await register(app, "owner", "other@example.com")).statusCode, 409);
    assert.equal((await register(app, "other", "owner@example.com")).statusCode, 409);

    const badLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.com", password: "wrong" },
    });
    assert.equal(badLogin.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("admin routes reject non-admin users and protect self/last-admin updates", async () => {
  const { app } = await makeApp();
  try {
    const owner = await register(app, "owner", "owner@example.com");
    const ownerCookie = authCookie(owner);
    const ownerId = owner.json().user.id as string;

    const createdUser = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "worker",
        email: "worker@example.com",
        password: "WorkerPass123!",
        isAdmin: false,
      },
    });
    assert.equal(createdUser.statusCode, 201);

    const workerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "worker@example.com", password: "WorkerPass123!" },
    });
    assert.equal(workerLogin.statusCode, 200);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: authCookie(workerLogin) },
    });
    assert.equal(forbidden.statusCode, 403);

    const suspendSelf = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${ownerId}`,
      headers: { cookie: ownerCookie },
      payload: { isActive: false },
    });
    assert.equal(suspendSelf.statusCode, 400);
    assert.equal(suspendSelf.json().error, "Cannot suspend your own account");

    const removeLastAdmin = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${ownerId}`,
      headers: { cookie: ownerCookie },
      payload: { isAdmin: false },
    });
    assert.equal(removeLastAdmin.statusCode, 400);
    assert.equal(removeLastAdmin.json().error, "Cannot remove the last admin");
  } finally {
    await app.close();
  }
});

test("admin middleware rejects stale admin cookies after demotion", async () => {
  const { app } = await makeApp();
  try {
    const owner = await register(app, "owner", "owner@example.com");
    const ownerCookie = authCookie(owner);

    const createdAdmin = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "admin2",
        email: "admin2@example.com",
        password: "AdminPass123!",
        isAdmin: true,
      },
    });
    assert.equal(createdAdmin.statusCode, 201);
    const adminId = createdAdmin.json().user.id as string;

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin2@example.com", password: "AdminPass123!" },
    });
    assert.equal(adminLogin.statusCode, 200);
    const staleAdminCookie = authCookie(adminLogin);

    const demote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: ownerCookie },
      payload: { isAdmin: false },
    });
    assert.equal(demote.statusCode, 200);
    assert.equal(demote.json().user.isAdmin, false);

    const staleAdminRequest = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: staleAdminCookie },
    });
    assert.equal(staleAdminRequest.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("admin user creation validates payload and applies default session limits", async () => {
  const { app } = await makeApp();
  try {
    const owner = await register(app, "owner", "owner@example.com");
    const ownerCookie = authCookie(owner);

    const weakPassword = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "weak",
        email: "weak@example.com",
        password: "short",
        isAdmin: false,
      },
    });
    assert.equal(weakPassword.statusCode, 400);

    const user = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "member",
        email: "member@example.com",
        password: "MemberPass123!",
        isAdmin: false,
      },
    });

    assert.equal(user.statusCode, 201);
    assert.equal(user.json().user.maxSessions, config.DEFAULT_USER_MAX_SESSIONS);
    assert.equal(user.json().user.sessionCount, 0);

    const storedUser = (await import("./db/client.js")).prisma as unknown as { __users: UserRecord[] };
    const passwordHash = storedUser.__users.find((item) => item.email === "member@example.com")?.passwordHash;
    assert.ok(passwordHash);
    assert.equal(await bcrypt.compare("MemberPass123!", passwordHash), true);
  } finally {
    await app.close();
  }
});

test("admin password reset validates payload and updates login credentials", async () => {
  const { app, prisma } = await makeApp();
  try {
    const owner = await register(app, "owner", "owner@example.com");
    const ownerCookie = authCookie(owner);

    const user = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "member",
        email: "member@example.com",
        password: "MemberPass123!",
        isAdmin: false,
      },
    });
    assert.equal(user.statusCode, 201);
    const userId = user.json().user.id as string;

    const weak = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/reset-password`,
      headers: { cookie: ownerCookie },
      payload: { password: "short" },
    });
    assert.equal(weak.statusCode, 400);

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/reset-password`,
      headers: { cookie: ownerCookie },
      payload: { password: "NewPass123!" },
    });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json(), { success: true });

    const storedHash = prisma.__users.find((item) => item.id === userId)?.passwordHash;
    assert.ok(storedHash);
    assert.equal(await bcrypt.compare("NewPass123!", storedHash), true);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "member@example.com", password: "MemberPass123!" },
    });
    assert.equal(oldLogin.statusCode, 401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "member@example.com", password: "NewPass123!" },
    });
    assert.equal(newLogin.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("admin user deletion protects self and removes other users", async () => {
  const { app, prisma } = await makeApp();
  try {
    const owner = await register(app, "owner", "owner@example.com");
    const ownerCookie = authCookie(owner);
    const ownerId = owner.json().user.id as string;

    const selfDelete = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${ownerId}`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(selfDelete.statusCode, 400);
    assert.equal(selfDelete.json().error, "Cannot delete your own account");

    const user = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "member",
        email: "member@example.com",
        password: "MemberPass123!",
        isAdmin: false,
      },
    });
    assert.equal(user.statusCode, 201);
    const userId = user.json().user.id as string;

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/missing-user",
      headers: { cookie: ownerCookie },
    });
    assert.equal(missing.statusCode, 404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${userId}`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(deleted.statusCode, 204);
    assert.equal(prisma.__users.some((item) => item.id === userId), false);
  } finally {
    await app.close();
  }
});

test("admin session listing routes expose active sessions with user and event counts", async () => {
  const { app, prisma } = await makeApp();
  try {
    const owner = await register(app, "owner", "owner@example.com");
    const ownerCookie = authCookie(owner);

    const user = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: ownerCookie },
      payload: {
        username: "member",
        email: "member@example.com",
        password: "MemberPass123!",
        isAdmin: false,
      },
    });
    assert.equal(user.statusCode, 201);
    const userId = user.json().user.id as string;

    prisma.__sessions.push(
      makeSession({
        id: "session-active",
        userId,
        name: "Research",
        status: "running",
        eventCount: 3,
      }),
      makeSession({
        id: "session-deleted",
        userId,
        name: "Deleted",
        status: "stopped",
        deletedAt: new Date(),
        eventCount: 9,
      })
    );

    const allSessions = await app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: ownerCookie },
    });
    assert.equal(allSessions.statusCode, 200);
    assert.deepEqual(allSessions.json().sessions, [{
      id: "session-active",
      name: "Research",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      user: { id: userId, username: "member", email: "member@example.com" },
      eventCount: 3,
    }]);

    const userSessions = await app.inject({
      method: "GET",
      url: `/api/admin/users/${userId}/sessions`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(userSessions.statusCode, 200);
    assert.deepEqual(userSessions.json().sessions, [{
      id: "session-active",
      name: "Research",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    }]);

    const missingUserSessions = await app.inject({
      method: "GET",
      url: "/api/admin/users/missing-user/sessions",
      headers: { cookie: ownerCookie },
    });
    assert.equal(missingUserSessions.statusCode, 404);
  } finally {
    await app.close();
  }
});
