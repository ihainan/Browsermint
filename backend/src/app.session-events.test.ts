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

type SessionRecord = {
  id: string;
  userId: string;
  deletedAt: Date | null;
};

type EventRecord = {
  id: string;
  sessionId: string;
  operationType: string;
  source: string;
  statusCode: number | null;
  metadata: unknown;
  createdAt: Date;
};

const owner = {
  id: "user-owner",
  username: "owner",
  email: "owner@example.com",
  isAdmin: false,
  isActive: true,
};

function authCookie(user = owner) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, isAdmin: user.isAdmin },
    config.JWT_SECRET,
    { expiresIn: "24h" }
  );
  return `browsermint_auth=${encodeURIComponent(token)}`;
}

function makeEvent(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: "event-1",
    sessionId: "session-owned",
    operationType: "ws_cdp",
    source: "agent",
    statusCode: 200,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makePrismaMock(options: {
  sessions?: SessionRecord[];
  events?: EventRecord[];
  dailyRows?: Array<{ date: string; count: number }>;
  hourlyRows?: Array<{ hour: number; count: number }>;
  capsolverRows?: Array<{ total: number; success: number; failed: number; avg_duration_ms: number | null }>;
} = {}) {
  const sessions = options.sessions ?? [{ id: "session-owned", userId: owner.id, deletedAt: null }];
  const events = options.events ?? [];
  const findManyCalls: Array<{ take?: number; skip?: number }> = [];
  let queryCall = 0;

  const prisma = {
    user: {
      findUnique: async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (args.where.id !== owner.id) return null;
        if (args.select) {
          return Object.fromEntries(Object.keys(args.select).map((key) => [key, owner[key as keyof typeof owner]]));
        }
        return { ...owner };
      },
    },
    session: {
      findFirst: async (args: { where: { id?: string; userId?: string; deletedAt?: null } }) =>
        sessions.find((session) =>
          (!args.where.id || session.id === args.where.id) &&
          (!args.where.userId || session.userId === args.where.userId) &&
          (!("deletedAt" in args.where) || session.deletedAt === args.where.deletedAt)
        ) ?? null,
      findMany: async (args: { where?: { userId?: string }; select?: Record<string, unknown> }) => {
        const filtered = sessions.filter((session) => !args.where?.userId || session.userId === args.where.userId);
        if (args.select?.id) return filtered.map((session) => ({ id: session.id }));
        return filtered;
      },
    },
    sessionEvent: {
      findMany: async (args: { where: { sessionId: string }; take?: number; skip?: number }) => {
        findManyCalls.push({ take: args.take, skip: args.skip });
        return events
          .filter((event) => event.sessionId === args.where.sessionId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 50));
      },
      count: async (args: { where: { sessionId?: string | { in: string[] }; operationType?: string; source?: string } }) => {
        const where = args.where;
        return events.filter((event) => {
          const sessionId = where.sessionId;
          if (typeof sessionId === "string" && event.sessionId !== sessionId) return false;
          if (sessionId && typeof sessionId === "object" && !sessionId.in.includes(event.sessionId)) return false;
          if (where.operationType && event.operationType !== where.operationType) return false;
          if (where.source && event.source !== where.source) return false;
          return true;
        }).length;
      },
      groupBy: async () => {
        const counts = new Map<string, number>();
        for (const event of events) counts.set(event.operationType, (counts.get(event.operationType) ?? 0) + 1);
        return [...counts.entries()].map(([operationType, count]) => ({ operationType, _count: { id: count } }));
      },
    },
    $queryRaw: async () => {
      queryCall += 1;
      if (queryCall === 1) return options.dailyRows ?? [];
      if (queryCall === 2) return options.hourlyRows ?? [];
      return options.capsolverRows ?? [];
    },
    $on: () => {},
    $disconnect: async () => {},
    __findManyCalls: findManyCalls,
  };

  return prisma as unknown as AppPrismaClient & { __findManyCalls: Array<{ take?: number; skip?: number }> };
}

async function makeApp(prisma: AppPrismaClient) {
  setPrismaForTests(prisma);
  return createApp({ logger: false, serveStatic: false });
}

test("GET /api/sessions/:id/events protects ownership and clamps pagination", async () => {
  const prisma = makePrismaMock({
    sessions: [{ id: "session-owned", userId: owner.id, deletedAt: null }],
    events: [
      makeEvent({ id: "event-new", createdAt: new Date("2026-01-02T00:00:00.000Z") }),
      makeEvent({ id: "event-old", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
    ],
  });
  const app = await makeApp(prisma);
  try {
    const oversized = await app.inject({
      method: "GET",
      url: "/api/sessions/session-owned/events?limit=500&offset=1",
      headers: { cookie: authCookie() },
    });
    assert.equal(oversized.statusCode, 200);
    assert.equal(oversized.json().limit, 200);
    assert.equal(oversized.json().offset, 1);
    assert.deepEqual(oversized.json().events.map((event: EventRecord) => event.id), ["event-old"]);

    const negative = await app.inject({
      method: "GET",
      url: "/api/sessions/session-owned/events?limit=-5&offset=-10",
      headers: { cookie: authCookie() },
    });
    assert.equal(negative.statusCode, 200);
    assert.equal(negative.json().limit, 50);
    assert.equal(negative.json().offset, 0);
    assert.deepEqual(prisma.__findManyCalls.at(-1), { take: 50, skip: 0 });

    const missing = await app.inject({
      method: "GET",
      url: "/api/sessions/other-session/events",
      headers: { cookie: authCookie() },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("GET /api/sessions/events/stats returns empty stats without sessions", async () => {
  const app = await makeApp(makePrismaMock({ sessions: [] }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/events/stats",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      dailyCounts: [],
      hourlyDistribution: [],
      byOperationType: {},
      agentEventCount: 0,
      capsolver: { total: 0, success: 0, failed: 0, avgDurationMs: null },
    });
  } finally {
    await app.close();
  }
});

test("GET /api/sessions/events/stats aggregates user event summaries", async () => {
  const app = await makeApp(makePrismaMock({
    sessions: [{ id: "session-owned", userId: owner.id, deletedAt: null }],
    events: [
      makeEvent({ id: "agent", operationType: "ws_cdp", source: "agent" }),
      makeEvent({ id: "frontend", operationType: "http_proxy", source: "frontend" }),
      makeEvent({ id: "capsolver", operationType: "capsolver", source: "backend" }),
    ],
    dailyRows: [{ date: "2026-01-01", count: 3 }],
    hourlyRows: [{ hour: 13, count: 2 }],
    capsolverRows: [{ total: 2, success: 1, failed: 1, avg_duration_ms: 1234.6 }],
  }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/events/stats",
      headers: { cookie: authCookie() },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      dailyCounts: [{ date: "2026-01-01", count: 3, agentCount: 3 }],
      hourlyDistribution: [{ hour: 13, count: 2, agentCount: 2 }],
      byOperationType: { ws_cdp: 1, http_proxy: 1, capsolver: 1 },
      agentEventCount: 1,
      capsolver: { total: 2, success: 1, failed: 1, avgDurationMs: 1235 },
    });
  } finally {
    await app.close();
  }
});
