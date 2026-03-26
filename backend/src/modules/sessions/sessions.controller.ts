import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../../db/client.js";
import { config } from "../../config.js";
import {
  createAndStartContainer,
  waitForContainerReady,
  stopAndRemoveContainer,
} from "../../services/docker.service.js";
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

  try {
    const containerInfo = await createAndStartContainer(sessionId);
    await waitForContainerReady(containerInfo.internalApiUrl);

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

    return reply.status(201).send({ session: updated });
  } catch (err) {
    console.error("Session creation failed:", err);
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

  await prisma.session.update({
    where: { id },
    data: { status: "stopping" },
  });

  if (session.containerId) {
    await stopAndRemoveContainer(session.containerId).catch(console.error);
  }

  await prisma.session.update({
    where: { id },
    data: { status: "stopped", deletedAt: new Date() },
  });

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

  await prisma.session.update({ where: { id }, data: { status: "stopping" } });

  if (session.containerId) {
    await stopAndRemoveContainer(session.containerId).catch(console.error);
  }

  const updated = await prisma.session.update({
    where: { id },
    data: {
      status: "stopped",
      containerId: null,
      containerName: null,
      internalApiUrl: null,
    },
  });

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

  await prisma.session.update({ where: { id }, data: { status: "creating" } });

  try {
    const containerInfo = await createAndStartContainer(id);
    await waitForContainerReady(containerInfo.internalApiUrl);

    const current = await prisma.session.findUnique({ where: { id } });
    if (!current || current.deletedAt) {
      await stopAndRemoveContainer(containerInfo.containerId).catch(() => {});
      return reply.status(409).send({ error: "Session was deleted during startup" });
    }

    const updated = await prisma.session.update({
      where: { id },
      data: {
        status: "running",
        containerId: containerInfo.containerId,
        containerName: containerInfo.containerName,
        internalApiUrl: containerInfo.internalApiUrl,
        lastActiveAt: new Date(),
      },
    });

    return reply.send({ session: updated });
  } catch (err) {
    console.error("Session start failed:", err);
    await prisma.session.update({ where: { id }, data: { status: "error" } });
    return reply.status(500).send({ error: "Failed to start browser session" });
  }
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
    { expiresIn: "15m" }
  );

  return reply.send({ token });
}
