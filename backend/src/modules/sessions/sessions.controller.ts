import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../../db/client.js";
import { config } from "../../config.js";
import {
  createAndStartContainer,
  startExistingContainer,
  waitForContainerReady,
  stopContainer,
  stopAndRemoveContainer,
} from "../../services/docker.service.js";
import {
  initCdpSession,
  cleanupCdpSession,
  closeBrowserGracefully,
  getOpenPageUrls,
  openSavedTabs,
} from "../../services/cdp.service.js";
import { CreateSessionBody } from "./sessions.schema.js";

// ─── Create Session ───────────────────────────────────────────────────────────

export async function handleCreateSession(
  request: FastifyRequest<{ Body: CreateSessionBody }>,
  reply: FastifyReply
) {
  const userId = request.user.sub;
  const { name } = request.body;

  // Enforce per-user session limit
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return reply.status(404).send({ error: "User not found" });

  const activeCount = await prisma.session.count({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["creating", "running"] },
    },
  });
  if (activeCount >= user.maxSessions) {
    return reply.status(429).send({
      error: `Session limit reached (max ${user.maxSessions})`,
    });
  }

  const sessionId = uuidv4();

  // Insert DB record first so reconcile can find it
  const session = await prisma.session.create({
    data: { id: sessionId, userId, name: name ?? null, status: "creating" },
  });

  console.info(`[session] Creating session ${sessionId} (user ${userId})`);

  try {
    const containerInfo = await createAndStartContainer(sessionId);
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
    // Try to clean up any partially-created container
    if (session.containerId) {
      await stopAndRemoveContainer(session.containerId).catch(() => {});
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
  if (session.status !== "running") {
    return reply.status(400).send({ error: "Session is not running" });
  }

  console.info(`[session] Stopping session ${id}`);

  await prisma.session.update({ where: { id }, data: { status: "stopping" } });

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
    await stopContainer(session.containerId).catch((err) =>
      console.error(`[session] Failed to stop container for session ${id}:`, err)
    );
  }

  const updated = await prisma.session.update({
    where: { id },
    data: {
      status: "stopped",
      // containerId / containerName / internalApiUrl intentionally kept so
      // handleStartSession can restart the same container.
      savedTabs: savedUrls.length > 0 ? savedUrls : null,
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

  const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
  if (!user) return reply.status(404).send({ error: "User not found" });

  const activeCount = await prisma.session.count({
    where: {
      userId: request.user.sub,
      deletedAt: null,
      status: { in: ["creating", "running"] },
    },
  });
  if (activeCount >= user.maxSessions) {
    return reply.status(429).send({
      error: `Session limit reached (max ${user.maxSessions})`,
    });
  }

  console.info(`[session] Resuming session ${id} (had container: ${session.containerId ? "yes" : "no"})`);

  await prisma.session.update({ where: { id }, data: { status: "creating" } });

  try {
    // If a container already exists (session was stopped, not deleted), restart it
    // so the browser's cookies and local storage are preserved.
    // Otherwise create a fresh container.
    let containerInfo = session.containerId
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
        savedTabs: null, // Clear after restore
      },
    });

    console.info(`[session] Session ${id} resumed (container ${containerInfo.containerName})`);
    return reply.send({ session: updated });
  } catch (err) {
    console.error(`[session] Failed to resume session ${id}:`, err);
    await prisma.session.update({ where: { id }, data: { status: "error" } });
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
      dailyCounts: [], hourlyDistribution: [], byOperationType: {},
      capsolver: { total: 0, success: 0, failed: 0, avgDurationMs: null },
    });
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 7);

  type DailyRow = { date: string; count: number };
  type HourlyRow = { hour: number; count: number };

  type CapsolverRow = { total: number; success: number; failed: number; avg_duration_ms: number | null };

  const [dailyRaw, hourlyRaw, byType, capsolverRaw] = await Promise.all([
    prisma.$queryRaw<DailyRow[]>`
      SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM session_events
      WHERE "sessionId" = ANY(${sessionIds}::uuid[])
        AND "createdAt" >= ${thirtyDaysAgo}
      GROUP BY TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      ORDER BY date
    `,
    prisma.$queryRaw<HourlyRow[]>`
      SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS hour,
             COUNT(*)::int AS count
      FROM session_events
      WHERE "sessionId" = ANY(${sessionIds}::uuid[])
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
  ]);

  const cap = capsolverRaw[0] ?? { total: 0, success: 0, failed: 0, avg_duration_ms: null };
  return reply.send({
    dailyCounts: dailyRaw,
    hourlyDistribution: hourlyRaw,
    byOperationType: Object.fromEntries(byType.map((t) => [t.operationType, t._count.id])),
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
  if (session.status !== "running") {
    return reply.status(400).send({ error: "Session is not running" });
  }

  const token = jwt.sign(
    { sub: request.user.sub, sessionId: id, type: "session" },
    config.JWT_SESSION_TOKEN_SECRET,
    { expiresIn: "180d" }
  );

  return reply.send({ token });
}
