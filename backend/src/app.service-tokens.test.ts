import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { AppPrismaClient } from "./db/client.js";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  SERVICE_ASSERTION_SECRET: "test-service-assertion-secret",
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
};

function makePrismaMock(users: UserRecord[]) {
  const prisma = {
    user: {
      upsert: async (args: {
        where: { username: string };
        create: Omit<UserRecord, "id" | "isActive">;
        update: Record<string, unknown>;
      }) => {
        let user = users.find((u) => u.username === args.where.username);
        if (!user) {
          user = {
            id: `uuid-${users.length + 1}`,
            isActive: true,
            isAdmin: false,
            maxSessions: 2,
            ...args.create,
          } as UserRecord;
          users.push(user);
        } else {
          Object.assign(user, args.update);
        }
        return { ...user };
      },
    },
    $on: () => {},
    $disconnect: async () => {},
    __users: users,
  };
  return prisma as unknown as AppPrismaClient & { __users: UserRecord[] };
}

function makeAssertion(payload: Record<string, unknown>, secret = "test-service-assertion-secret") {
  return jwt.sign({ purpose: "agent-token", act_for: "unionid-1", ...payload }, secret, {
    expiresIn: "5m",
  });
}

test("POST /api/service/agent-tokens mints a Bearer token accepted by authMiddleware payload shape", async () => {
  const prisma = makePrismaMock([]);
  setPrismaForTests(prisma);
  const app = await createApp({ logger: false, serveStatic: false });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      headers: { "x-service-assertion": makeAssertion({}) },
      payload: { agent_id: "42" },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json() as { token: string; username: string; user_id: string };
    assert.equal(body.username, "agent-42");
    const decoded = jwt.verify(body.token, config.JWT_SECRET) as { sub: string; username: string; isAdmin: boolean };
    assert.equal(decoded.sub, body.user_id);
    assert.equal(decoded.username, "agent-42");
    assert.equal(decoded.isAdmin, false);
    assert.equal(prisma.__users.length, 1);
    assert.equal(prisma.__users[0].passwordHash.startsWith("!"), true);
  } finally {
    await app.close();
  }
});

test("POST /api/service/agent-tokens is idempotent per agent and keeps existing account settings", async () => {
  const prisma = makePrismaMock([
    {
      id: "uuid-existing",
      username: "agent-42",
      email: "agent-42@service.browsermint.internal",
      passwordHash: "!service-account-no-password",
      isAdmin: false,
      isActive: true,
      maxSessions: 7,
    },
  ]);
  setPrismaForTests(prisma);
  const app = await createApp({ logger: false, serveStatic: false });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      headers: { "x-service-assertion": makeAssertion({}) },
      payload: { agent_id: "42", max_sessions: 3 },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json() as { user_id: string; max_sessions: number };
    assert.equal(body.user_id, "uuid-existing");
    assert.equal(body.max_sessions, 7);
    assert.equal(prisma.__users.length, 1);
  } finally {
    await app.close();
  }
});

test("POST /api/service/agent-tokens rejects bad assertions and bad agent ids", async () => {
  const prisma = makePrismaMock([]);
  setPrismaForTests(prisma);
  const app = await createApp({ logger: false, serveStatic: false });
  try {
    // Missing assertion
    let res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      payload: { agent_id: "42" },
    });
    assert.equal(res.statusCode, 401);

    // Wrong secret
    res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      headers: { "x-service-assertion": makeAssertion({}, "another-secret-entirely-xx") },
      payload: { agent_id: "42" },
    });
    assert.equal(res.statusCode, 401);

    // Wrong purpose
    res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      headers: { "x-service-assertion": makeAssertion({ purpose: "other" }) },
      payload: { agent_id: "42" },
    });
    assert.equal(res.statusCode, 401);

    // Invalid agent_id
    res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      headers: { "x-service-assertion": makeAssertion({}) },
      payload: { agent_id: "bad/../id" },
    });
    assert.equal(res.statusCode, 400);

    assert.equal(prisma.__users.length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/service/agent-tokens rejects deactivated agent accounts", async () => {
  const prisma = makePrismaMock([
    {
      id: "uuid-disabled",
      username: "agent-9",
      email: "agent-9@service.browsermint.internal",
      passwordHash: "!service-account-no-password",
      isAdmin: false,
      isActive: false,
      maxSessions: 2,
    },
  ]);
  setPrismaForTests(prisma);
  const app = await createApp({ logger: false, serveStatic: false });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/service/agent-tokens",
      headers: { "x-service-assertion": makeAssertion({}) },
      payload: { agent_id: "9" },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});
