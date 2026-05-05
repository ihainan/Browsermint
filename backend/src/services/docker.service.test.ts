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
import type { ContainerInfo, SessionRecoveredCallback } from "./docker.service.js";

type SessionRecord = {
  id: string;
  status: string;
  containerId: string | null;
  containerName: string | null;
  internalApiUrl: string | null;
  onlineMs: number;
  runningStartedAt: Date | null;
  deletedAt: Date | null;
  autoRestartAttempts: number;
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
    autoRestartAttempts: 0,
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
    if (value && typeof value === "object" && "increment" in value) {
      const current = Number((session as unknown as Record<string, unknown>)[key] ?? 0);
      (session as unknown as Record<string, unknown>)[key] =
        current + Number((value as { increment: number }).increment);
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
  startup = false,
  extra?: {
    onSessionRecovered?: SessionRecoveredCallback;
    startExistingContainer?: (containerId: string) => Promise<ContainerInfo>;
  }
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
    startExistingContainer: extra?.startExistingContainer
      ? async (containerId) => {
          calls.push(`docker:start:${containerId}`);
          return extra.startExistingContainer!(containerId);
        }
      : undefined,
  });

  await reconcileContainers(startup, extra?.onSessionRecovered);
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
          autoRestartAttempts: 3,
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

test("reconcileContainers auto-restarts an exited running session and fires recovery callback", async () => {
  const originalNow = Date.now;
  Date.now = () => 30_000;
  const recoveredSessions: Array<{ sessionId: string; url: string }> = [];
  try {
    const { prisma, calls } = await runReconcileTest(
      [
        makeSession({
          id: "auto-restart-ok",
          containerId: "container-exited",
          runningStartedAt: new Date(25_000),
          autoRestartAttempts: 0,
        }),
      ],
      [makeContainer("container-exited", "auto-restart-ok", "exited")],
      false,
      {
        onSessionRecovered: (sessionId, url) => recoveredSessions.push({ sessionId, url }),
        startExistingContainer: async () => ({
          containerId: "container-exited",
          containerName: "browsermint-session-auto-restart-ok",
          internalApiUrl: "http://10.0.0.2:3000",
        }),
      }
    );

    assert.ok(calls.includes("docker:start:container-exited"));
    assert.equal(prisma.__sessions[0].status, "running");
    assert.equal(prisma.__sessions[0].autoRestartAttempts, 0);
    assert.equal(prisma.__sessions[0].internalApiUrl, "http://10.0.0.2:3000");
    assert.deepEqual(prisma.__sessions[0].runningStartedAt, new Date(30_000));
    assert.equal(recoveredSessions.length, 1);
    assert.equal(recoveredSessions[0].sessionId, "auto-restart-ok");
    assert.equal(recoveredSessions[0].url, "http://10.0.0.2:3000");
  } finally {
    Date.now = originalNow;
  }
});

test("reconcileContainers increments autoRestartAttempts on start failure", async () => {
  const { prisma, calls } = await runReconcileTest(
    [
      makeSession({
        id: "auto-restart-fail",
        containerId: "container-exited-fail",
        autoRestartAttempts: 1,
      }),
    ],
    [makeContainer("container-exited-fail", "auto-restart-fail", "exited")],
    false,
    {
      startExistingContainer: async () => { throw new Error("daemon error"); },
    }
  );

  assert.ok(calls.includes("docker:start:container-exited-fail"));
  assert.equal(prisma.__sessions[0].status, "running");
  assert.equal(prisma.__sessions[0].autoRestartAttempts, 2);
});

test("reconcileContainers marks error immediately when autoRestartAttempts exhausted", async () => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const { prisma, calls } = await runReconcileTest(
      [
        makeSession({
          id: "auto-restart-exhausted",
          containerId: "container-exited-ex",
          runningStartedAt: new Date(8_000),
          autoRestartAttempts: 3,
        }),
      ],
      [makeContainer("container-exited-ex", "auto-restart-exhausted", "exited")]
    );

    assert.ok(!calls.some((c) => c.startsWith("docker:start")));
    assert.equal(prisma.__sessions[0].status, "error");
    assert.equal(prisma.__sessions[0].onlineMs, 2_000);
    assert.equal(prisma.__sessions[0].runningStartedAt, null);
  } finally {
    Date.now = originalNow;
  }
});

test("reconcileContainers marks error immediately for non-exited container states (e.g. dead)", async () => {
  const { prisma, calls } = await runReconcileTest(
    [
      makeSession({
        id: "dead-session",
        containerId: "container-dead",
        autoRestartAttempts: 0,
      }),
    ],
    [makeContainer("container-dead", "dead-session", "dead")]
  );

  assert.ok(!calls.some((c) => c.startsWith("docker:start")));
  assert.equal(prisma.__sessions[0].status, "error");
});

test("reconcileContainers marks error immediately when container is gone (404) without incrementing counter", async () => {
  const { prisma } = await runReconcileTest(
    [
      makeSession({
        id: "auto-restart-404",
        containerId: "container-exited-404",
        autoRestartAttempts: 0,
      }),
    ],
    [makeContainer("container-exited-404", "auto-restart-404", "exited")],
    false,
    {
      startExistingContainer: async () => { const e = new Error("Not found") as Error & { statusCode?: number }; e.statusCode = 404; throw e; },
    }
  );

  assert.equal(prisma.__sessions[0].status, "error");
  assert.equal(prisma.__sessions[0].autoRestartAttempts, 0);
});

test("reconcileContainers auto-restarts a paused session whose container exited, sets status to running", async () => {
  const recoveredSessions: Array<{ sessionId: string; url: string }> = [];
  const { prisma, calls } = await runReconcileTest(
    [
      makeSession({
        id: "paused-exited",
        status: "paused",
        containerId: "container-paused-exited",
        autoRestartAttempts: 0,
      }),
    ],
    [makeContainer("container-paused-exited", "paused-exited", "exited")],
    false,
    {
      onSessionRecovered: (sessionId, url) => recoveredSessions.push({ sessionId, url }),
      startExistingContainer: async () => ({
        containerId: "container-paused-exited",
        containerName: "browsermint-session-paused-exited",
        internalApiUrl: "http://10.0.0.3:3000",
      }),
    }
  );

  assert.ok(calls.includes("docker:start:container-paused-exited"));
  assert.equal(prisma.__sessions[0].status, "running");
  assert.equal(prisma.__sessions[0].autoRestartAttempts, 0);
  assert.equal(recoveredSessions.length, 1);
  assert.equal(recoveredSessions[0].sessionId, "paused-exited");
});

test("reconcileContainers resets autoRestartAttempts to 0 on successful restart after prior failures", async () => {
  const { prisma } = await runReconcileTest(
    [
      makeSession({
        id: "retry-success",
        containerId: "container-retry",
        autoRestartAttempts: 2,
      }),
    ],
    [makeContainer("container-retry", "retry-success", "exited")],
    false,
    {
      startExistingContainer: async () => ({
        containerId: "container-retry",
        containerName: "browsermint-session-retry-success",
        internalApiUrl: "http://10.0.0.4:3000",
      }),
    }
  );

  assert.equal(prisma.__sessions[0].status, "running");
  assert.equal(prisma.__sessions[0].autoRestartAttempts, 0);
});
