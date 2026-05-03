import test from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import type { AppPrismaClient } from "../db/client.js";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const { setPrismaForTests } = await import("../db/client.js");
const {
  reconcileContainers,
  resetDockerServiceOverridesForTests,
  setDockerServiceOverridesForTests,
} = await import("./docker.service.js");

type SessionRecord = {
  id: string;
  status: string;
  containerId: string | null;
  containerName: string | null;
  internalApiUrl: string | null;
  onlineMs: number;
  runningStartedAt: Date | null;
  deletedAt: Date | null;
};

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "session-1",
    status: "running",
    containerId: "container-1",
    containerName: "browsermint-session-1",
    internalApiUrl: "http://127.0.0.1:3000",
    onlineMs: 0,
    runningStartedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    runningStartedAt: session.runningStartedAt ? new Date(session.runningStartedAt) : null,
    deletedAt: session.deletedAt ? new Date(session.deletedAt) : null,
  };
}

function matchesWhere(session: SessionRecord, where: Record<string, unknown>) {
  if ("deletedAt" in where && session.deletedAt !== where.deletedAt) return false;
  const status = where.status as { in?: string[] } | string | undefined;
  if (typeof status === "string" && session.status !== status) return false;
  if (status && typeof status === "object" && status.in && !status.in.includes(session.status)) return false;
  const containerId = where.containerId as { not?: null } | undefined;
  if (containerId && "not" in containerId && containerId.not === null && session.containerId === null) {
    return false;
  }
  return true;
}

function applyUpdate(session: SessionRecord, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (key === "onlineMs" && value && typeof value === "object" && "increment" in value) {
      session.onlineMs += Number((value as { increment: number }).increment);
      continue;
    }
    (session as unknown as Record<string, unknown>)[key] = value;
  }
}

function makePrismaMock(seedSessions: SessionRecord[]) {
  const sessions = [...seedSessions];
  const prisma = {
    session: {
      findUnique: async (args: { where: { id: string } }) => {
        const session = sessions.find((item) => item.id === args.where.id);
        return session ? cloneSession(session) : null;
      },
      findMany: async (args: { where?: Record<string, unknown> }) =>
        sessions.filter((session) => !args.where || matchesWhere(session, args.where)).map(cloneSession),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const session = sessions.find((item) => item.id === args.where.id);
        if (!session) throw new Error(`Session not found: ${args.where.id}`);
        applyUpdate(session, args.data);
        return cloneSession(session);
      },
    },
    $on: () => {},
    $disconnect: async () => {},
    __sessions: sessions,
  };
  return prisma as unknown as AppPrismaClient & { __sessions: SessionRecord[] };
}

function makeContainer(id: string, sessionId: string, state: string): Docker.ContainerInfo {
  return {
    Id: id,
    Names: [`/browsermint-session-${sessionId}`],
    Image: "browsermint-browser:latest",
    ImageID: "image-id",
    Command: "",
    Created: 0,
    Ports: [],
    Labels: {
      "browsermint.managed": "true",
      "browsermint.session": sessionId,
    },
    State: state,
    Status: state,
    HostConfig: { NetworkMode: "browsermint" },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  } as Docker.ContainerInfo;
}

async function runReconcileTest(
  seedSessions: SessionRecord[],
  containers: Docker.ContainerInfo[],
  startup = false
) {
  const calls: string[] = [];
  const prisma = makePrismaMock(seedSessions);
  setPrismaForTests(prisma);
  setDockerServiceOverridesForTests({
    listContainers: async () => {
      calls.push("docker:list");
      return containers;
    },
    stopContainer: async (containerId) => {
      calls.push(`docker:stop:${containerId}`);
    },
    stopAndRemoveContainer: async (containerId) => {
      calls.push(`docker:remove:${containerId}`);
    },
  });

  await reconcileContainers(startup);
  resetDockerServiceOverridesForTests();
  return { prisma, calls };
}

test("reconcileContainers removes orphan and deleted-session containers", async () => {
  const { calls } = await runReconcileTest(
    [makeSession({ id: "deleted", containerId: "container-deleted", deletedAt: new Date() })],
    [
      makeContainer("container-orphan", "missing", "running"),
      makeContainer("container-deleted", "deleted", "running"),
    ]
  );

  assert.ok(calls.includes("docker:list"));
  assert.ok(calls.includes("docker:remove:container-orphan"));
  assert.ok(calls.includes("docker:remove:container-deleted"));
});

test("reconcileContainers marks running sessions with missing or stopped containers as error", async () => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const { prisma } = await runReconcileTest(
      [
        makeSession({
          id: "missing-running",
          containerId: "container-missing",
          onlineMs: 500,
          runningStartedAt: new Date(7_000),
        }),
        makeSession({
          id: "stopped-running",
          containerId: "container-stopped",
          runningStartedAt: new Date(9_000),
        }),
      ],
      [makeContainer("container-stopped", "stopped-running", "exited")]
    );

    assert.equal(prisma.__sessions[0].status, "error");
    assert.equal(prisma.__sessions[0].onlineMs, 3_500);
    assert.equal(prisma.__sessions[0].runningStartedAt, null);
    assert.equal(prisma.__sessions[1].status, "error");
    assert.equal(prisma.__sessions[1].onlineMs, 1_000);
    assert.equal(prisma.__sessions[1].runningStartedAt, null);
  } finally {
    Date.now = originalNow;
  }
});

test("reconcileContainers corrects running and paused mismatches without losing online time tracking", async () => {
  const originalNow = Date.now;
  Date.now = () => 20_000;
  try {
    const { prisma } = await runReconcileTest(
      [
        makeSession({
          id: "running-but-paused",
          status: "running",
          containerId: "container-paused",
          onlineMs: 1_000,
          runningStartedAt: new Date(15_000),
        }),
        makeSession({
          id: "paused-but-running",
          status: "paused",
          containerId: "container-running",
          onlineMs: 7_000,
          runningStartedAt: null,
        }),
      ],
      [
        makeContainer("container-paused", "running-but-paused", "paused"),
        makeContainer("container-running", "paused-but-running", "running"),
      ]
    );

    assert.equal(prisma.__sessions[0].status, "paused");
    assert.equal(prisma.__sessions[0].onlineMs, 6_000);
    assert.equal(prisma.__sessions[0].runningStartedAt, null);
    assert.equal(prisma.__sessions[1].status, "running");
    assert.equal(prisma.__sessions[1].onlineMs, 7_000);
    assert.deepEqual(prisma.__sessions[1].runningStartedAt, new Date(20_000));
  } finally {
    Date.now = originalNow;
  }
});

test("reconcileContainers completes stuck stopping sessions and startup-only creating sessions", async () => {
  const originalNow = Date.now;
  Date.now = () => 50_000;
  try {
    const { prisma, calls } = await runReconcileTest(
      [
        makeSession({
          id: "stopping",
          status: "stopping",
          containerId: "container-stopping",
          onlineMs: 10,
          runningStartedAt: new Date(49_000),
        }),
        makeSession({
          id: "creating",
          status: "creating",
          containerId: "container-creating",
        }),
      ],
      [
        makeContainer("container-stopping", "stopping", "running"),
        makeContainer("container-creating", "creating", "running"),
      ],
      true
    );

    assert.equal(prisma.__sessions[0].status, "stopped");
    assert.equal(prisma.__sessions[0].onlineMs, 1_010);
    assert.equal(prisma.__sessions[0].runningStartedAt, null);
    assert.equal(prisma.__sessions[1].status, "error");
    assert.ok(calls.includes("docker:stop:container-stopping"));
  } finally {
    Date.now = originalNow;
  }
});

test("reconcileContainers removes running containers for error sessions and clears metadata", async () => {
  const { prisma, calls } = await runReconcileTest(
    [
      makeSession({
        id: "error-running",
        status: "error",
        containerId: "container-error-running",
        containerName: "browsermint-session-error-running",
        internalApiUrl: "http://127.0.0.1:3000",
      }),
    ],
    [makeContainer("container-error-running", "error-running", "running")]
  );

  assert.ok(calls.includes("docker:remove:container-error-running"));
  assert.equal(prisma.__sessions[0].containerId, null);
  assert.equal(prisma.__sessions[0].containerName, null);
  assert.equal(prisma.__sessions[0].internalApiUrl, null);
});
