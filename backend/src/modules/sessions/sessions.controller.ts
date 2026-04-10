import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";

// Session token validity: 180 days. TODO: make this configurable via config.
const SESSION_EXPIRY_MS = 180 * 24 * 60 * 60 * 1000;
import { v4 as uuidv4 } from "uuid";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { config } from "../../config.js";
import {
  createAndStartContainer,
  startExistingContainer,
  waitForContainerReady,
  stopContainer,
  stopAndRemoveContainer,
  type ContainerInfo,
} from "../../services/docker.service.js";
import {
  initCdpSession,
  cleanupCdpSession,
  closeBrowserGracefully,
  getOpenPageUrls,
  openSavedTabs,
} from "../../services/cdp.service.js";
import { clearIdleTimer } from "../../services/proxy.service.js";
import { CreateSessionBody } from "./sessions.schema.js";

// ─── Create Session ───────────────────────────────────────────────────────────

export async function handleCreateSession(
  request: FastifyRequest<{ Body: CreateSessionBody }>,
  reply: FastifyReply
) {
  const userId = request.user.sub;
  const { name } = request.body;
  const sessionId = uuidv4();

  // Atomically check the per-user session limit and insert the new session record.
  // SELECT...FOR UPDATE on the user row serializes concurrent requests from the same
  // user, preventing the TOCTOU race where two simultaneous requests both pass the
  // count check and create sessions beyond maxSessions.
  let session!: Awaited<ReturnType<typeof prisma.session.create>>;
  try {
    session = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw Object.assign(new Error(), { _code: "USER_NOT_FOUND" });
      const activeCount = await tx.session.count({
        where: { userId, deletedAt: null, status: { in: ["creating", "running", "paused"] } },
      });
      if (activeCount >= user.maxSessions) {
        throw Object.assign(new Error(), { _code: "LIMIT_EXCEEDED", _max: user.maxSessions });
      }
      return tx.session.create({
        data: { id: sessionId, userId, name: name ?? null, status: "creating" },
      });
    });
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e._code === "USER_NOT_FOUND") return reply.status(404).send({ error: "User not found" });
    if (e._code === "LIMIT_EXCEEDED") return reply.status(429).send({ error: `Session limit reached (max ${e._max})` });
    throw err;
  }

  console.info(`[session] Creating session ${sessionId} (user ${userId})`);

  let containerInfo: ContainerInfo | undefined;
  try {
    containerInfo = await createAndStartContainer(sessionId);
    await waitForContainerReady(containerInfo.internalApiUrl);
    await initCdpSession(sessionId, containerInfo.internalApiUrl);

    // Session may have been deleted by the user while container was starting
    const current = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!current || current.deletedAt) {
      await stopAndRemoveContainer(containerInfo.containerId).catch(() => {});
      return reply.status(409).send({ error: "Session was deleted during creation" });
    }

    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: "running",
        containerId: containerInfo.containerId,
        containerName: containerInfo.containerName,
        internalApiUrl: containerInfo.internalApiUrl,
        lastActiveAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS),
      },
    });

    console.info(`[session] Session ${sessionId} created and running (container ${containerInfo.containerName})`);
    return reply.status(201).send({ session: updated });
  } catch (err) {
    console.error(`[session] Failed to create session ${sessionId}:`, err);
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: "error" },
    });
    // Clean up any container that was started before the failure
    if (containerInfo) {
      await stopAndRemoveContainer(containerInfo.containerId).catch(() => {});
    }
    return reply.status(500).send({ error: "Failed to start browser session" });
  }
}

// ─── List Sessions ────────────────────────────────────────────────────────────

export async function handleListSessions(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const userId = request.user.sub;
  const sessions = await prisma.session.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return reply.send({ sessions });
}

// ─── Get Session ──────────────────────────────────────────────────────────────

export async function handleGetSession(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });
  return reply.send({ session });
}

// ─── Delete Session ───────────────────────────────────────────────────────────

export async function handleDeleteSession(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });

  console.info(`[session] Deleting session ${id}`);

  clearIdleTimer(id);

  await prisma.session.update({
    where: { id },
    data: { status: "stopping" },
  });

  // Close Chrome gracefully so it flushes data before container removal
  await closeBrowserGracefully(id).catch(() => {});
  cleanupCdpSession(id);
  if (session.containerId) {
    await stopAndRemoveContainer(session.containerId).catch((err) =>
      console.error(`[session] Failed to remove container for session ${id}:`, err)
    );
  }

  await prisma.session.update({
    where: { id },
    data: { status: "stopped", deletedAt: new Date() },
  });

  console.info(`[session] Session ${id} deleted`);
  return reply.send({ success: true });
}

// ─── Stop Session (keep session, stop container) ─────────────────────────────

export async function handleStopSession(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });
  if (session.status !== "running" && session.status !== "paused") {
    return reply.status(400).send({ error: "Session is not running" });
  }

  console.info(`[session] Stopping session ${id}`);

  clearIdleTimer(id);
  await prisma.session.update({ where: { id }, data: { status: "stopping" } });

  // Paused sessions: Chrome is frozen, skip CDP operations and go straight to docker stop.
  // docker stop handles paused containers by unpausing then stopping them.
  if (session.status === "paused") {
    cleanupCdpSession(id);
    if (session.containerId) {
      try {
        await stopContainer(session.containerId);
      } catch (err) {
        console.error(`[session] Failed to stop container for session ${id}:`, err);
        await prisma.session.update({ where: { id }, data: { status: "error" } });
        return reply.status(500).send({ error: "Failed to stop browser session" });
      }
    }
    const updated = await prisma.session.update({
      where: { id },
      data: { status: "stopped" },
    });
    console.info(`[session] Session ${id} stopped`);
    return reply.send({ session: updated });
  }

  // Save open tab URLs before closing, so they can be restored on resume
  const savedUrls = await getOpenPageUrls(id);
  if (savedUrls.length > 0) {
    console.info(`[session] Session ${id}: saving ${savedUrls.length} open tab(s)`);
  }

  // Ask Chrome to close itself cleanly — this flushes session data and removes
  // lock files, preventing profile corruption on the next container start.
  const graceful = await closeBrowserGracefully(id);
  if (!graceful) {
    console.warn(`[session] Session ${id}: graceful Chrome close failed, proceeding with docker stop`);
  }
  cleanupCdpSession(id);

  if (session.containerId) {
    // Stop-only: container filesystem (cookies, browser data) is preserved for resume.
    try {
      await stopContainer(session.containerId);
    } catch (err) {
      console.error(`[session] Failed to stop container for session ${id}:`, err);
      await prisma.session.update({ where: { id }, data: { status: "error" } });
      return reply.status(500).send({ error: "Failed to stop browser session" });
    }
  }

  const updated = await prisma.session.update({
    where: { id },
    data: {
      status: "stopped",
      // containerId / containerName / internalApiUrl intentionally kept so
      // handleStartSession can restart the same container.
      savedTabs: savedUrls.length > 0 ? savedUrls : Prisma.JsonNull,
    },
  });

  console.info(`[session] Session ${id} stopped`);
  return reply.send({ session: updated });
}

// ─── Start Session (restart a stopped session) ────────────────────────────────

export async function handleStartSession(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });
  if (session.status !== "stopped" && session.status !== "error") {
    return reply.status(400).send({ error: "Session is not stopped" });
  }

  // Atomically check the per-user session limit and mark the session as "creating".
  // Same SELECT...FOR UPDATE pattern as handleCreateSession to prevent TOCTOU races.
  const userId = request.user.sub;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw Object.assign(new Error(), { _code: "USER_NOT_FOUND" });
      const activeCount = await tx.session.count({
        where: { userId, deletedAt: null, status: { in: ["creating", "running", "paused"] } },
      });
      if (activeCount >= user.maxSessions) {
        throw Object.assign(new Error(), { _code: "LIMIT_EXCEEDED", _max: user.maxSessions });
      }
      await tx.session.update({ where: { id }, data: { status: "creating" } });
    });
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e._code === "USER_NOT_FOUND") return reply.status(404).send({ error: "User not found" });
    if (e._code === "LIMIT_EXCEEDED") return reply.status(429).send({ error: `Session limit reached (max ${e._max})` });
    throw err;
  }

  console.info(`[session] Resuming session ${id} (had container: ${session.containerId ? "yes" : "no"})`);

  let containerInfo: ContainerInfo | undefined;
  try {
    // If a container already exists (session was stopped, not deleted), restart it
    // so the browser's cookies and local storage are preserved.
    // Otherwise create a fresh container.
    containerInfo = session.containerId
      ? await startExistingContainer(session.containerId)
      : await createAndStartContainer(id);

    await waitForContainerReady(containerInfo.internalApiUrl);
    const cdpReady = await initCdpSession(id, containerInfo.internalApiUrl);

    if (!cdpReady) {
      // Chrome failed to start inside the existing container (likely a corrupted profile
      // from a previous forced SIGKILL). Discard the broken container and create a fresh
      // one. Browser state (cookies, local storage) will be lost for this session.
      console.warn(`[session] Session ${id}: Chrome unreachable — discarding broken container, creating fresh one (browser state lost)`);
      await stopAndRemoveContainer(containerInfo.containerId).catch(() => {});
      containerInfo = await createAndStartContainer(id);
      await waitForContainerReady(containerInfo.internalApiUrl);
      await initCdpSession(id, containerInfo.internalApiUrl);
    }

    const current = await prisma.session.findUnique({ where: { id } });
    if (!current || current.deletedAt) {
      await stopContainer(containerInfo.containerId).catch(() => {});
      return reply.status(409).send({ error: "Session was deleted during startup" });
    }

    // Restore tabs saved before the session was stopped
    const savedTabs = Array.isArray(session.savedTabs)
      ? (session.savedTabs as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (savedTabs.length > 0) {
      console.info(`[session] Session ${id}: restoring ${savedTabs.length} saved tab(s)`);
      await openSavedTabs(id, savedTabs);
    }

    const updated = await prisma.session.update({
      where: { id },
      data: {
        status: "running",
        containerId: containerInfo.containerId,
        containerName: containerInfo.containerName,
        internalApiUrl: containerInfo.internalApiUrl,
        lastActiveAt: new Date(),
        savedTabs: Prisma.JsonNull, // Clear after restore
        expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS),
      },
    });

    console.info(`[session] Session ${id} resumed (container ${containerInfo.containerName})`);
    return reply.send({ session: updated });
  } catch (err) {
    console.error(`[session] Failed to resume session ${id}:`, err);
    await prisma.session.update({ where: { id }, data: { status: "error" } });
    // Clean up any container that was started before the failure
    if (containerInfo) {
      await stopAndRemoveContainer(containerInfo.containerId).catch(() => {});
    }
    return reply.status(500).send({ error: "Failed to start browser session" });
  }
}

// ─── List Session Events ──────────────────────────────────────────────────────

export async function handleListSessionEvents(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });

  const limit = Math.min(200, parseInt(request.query.limit ?? "50", 10) || 50);
  const offset = parseInt(request.query.offset ?? "0", 10) || 0;

  const [events, total] = await Promise.all([
    prisma.sessionEvent.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.sessionEvent.count({ where: { sessionId: id } }),
  ]);

  return reply.send({ events, total, limit, offset });
}

// ─── Events Stats (user-wide) ─────────────────────────────────────────────────

export async function handleGetEventsStats(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const userId = request.user.sub;

  const sessions = await prisma.session.findMany({
    where: { userId },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  if (sessionIds.length === 0) {
    return reply.send({
      dailyCounts: [], hourlyDistribution: [], byOperationType: {}, agentEventCount: 0,
      capsolver: { total: 0, success: 0, failed: 0, avgDurationMs: null },
    });
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 7);

  type DailyRow = { date: string; count: number };
  type HourlyRow = { hour: number; count: number };

  type CapsolverRow = { total: number; success: number; failed: number; avg_duration_ms: number | null };

  const [dailyRaw, hourlyRaw, byType, capsolverRaw, agentEventCountRaw] = await Promise.all([
    prisma.$queryRaw<DailyRow[]>`
      SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM session_events
      WHERE "sessionId" = ANY(${sessionIds}::uuid[])
        AND "operationType" = 'ws_cdp'
        AND source = 'agent'
        AND "createdAt" >= ${thirtyDaysAgo}
      GROUP BY TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      ORDER BY date
    `,
    prisma.$queryRaw<HourlyRow[]>`
      SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS hour,
             COUNT(*)::int AS count
      FROM session_events
      WHERE "sessionId" = ANY(${sessionIds}::uuid[])
        AND "operationType" = 'ws_cdp'
        AND source = 'agent'
      GROUP BY EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')
      ORDER BY hour
    `,
    prisma.sessionEvent.groupBy({
      by: ["operationType"],
      where: { sessionId: { in: sessionIds } },
      _count: { id: true },
    }),
    prisma.$queryRaw<CapsolverRow[]>`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE "statusCode" = 200)::int AS success,
        COUNT(*) FILTER (WHERE "statusCode" != 200)::int AS failed,
        AVG((metadata->>'durationMs')::numeric)::numeric AS avg_duration_ms
      FROM session_events
      WHERE "sessionId" = ANY(${sessionIds}::uuid[])
        AND "operationType" = 'capsolver'
    `,
    prisma.sessionEvent.count({
      where: { sessionId: { in: sessionIds }, operationType: "ws_cdp", source: "agent" },
    }),
  ]);

  const cap = capsolverRaw[0] ?? { total: 0, success: 0, failed: 0, avg_duration_ms: null };
  return reply.send({
    dailyCounts: dailyRaw.map((r) => ({ date: r.date, count: Number(r.count), agentCount: Number(r.count) })),
    hourlyDistribution: hourlyRaw.map((r) => ({ hour: r.hour, count: Number(r.count), agentCount: Number(r.count) })),
    byOperationType: Object.fromEntries(byType.map((t) => [t.operationType, t._count.id])),
    agentEventCount: agentEventCountRaw,
    capsolver: {
      total: Number(cap.total),
      success: Number(cap.success),
      failed: Number(cap.failed),
      avgDurationMs: cap.avg_duration_ms != null ? Math.round(Number(cap.avg_duration_ms)) : null,
    },
  });
}

// ─── Issue Session Token ──────────────────────────────────────────────────────

export async function handleCreateSessionToken(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });
  if (session.status !== "running" && session.status !== "paused") {
    return reply.status(400).send({ error: "Session is not running" });
  }

  const token = jwt.sign(
    { sub: request.user.sub, sessionId: id, type: "session" },
    config.JWT_SESSION_TOKEN_SECRET,
    { expiresIn: "180d" }
  );

  return reply.send({ token });
}

// ─── Refresh Session Token ────────────────────────────────────────────────────
// Issues a new token AND updates expiresAt on the session record. Called when
// the user explicitly requests a token refresh from the session detail page.

export async function handleRefreshSessionToken(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const session = await prisma.session.findFirst({
    where: { id, userId: request.user.sub, deletedAt: null },
  });
  if (!session) return reply.status(404).send({ error: "Session not found" });
  if (session.status !== "running" && session.status !== "paused") {
    return reply.status(400).send({ error: "Session is not running" });
  }

  const token = jwt.sign(
    { sub: request.user.sub, sessionId: id, type: "session" },
    config.JWT_SESSION_TOKEN_SECRET,
    { expiresIn: "180d" }
  );

  // Decode to get the exact iat so we can reject tokens issued before this one.
  const decoded = jwt.decode(token) as { iat: number };
  const tokenIssuedAt = new Date(decoded.iat * 1000);

  const updated = await prisma.session.update({
    where: { id },
    data: {
      expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS),
      tokenIssuedAt,
    },
  });

  return reply.send({ token, session: updated });
}
