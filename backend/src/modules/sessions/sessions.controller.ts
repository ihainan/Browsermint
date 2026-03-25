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
