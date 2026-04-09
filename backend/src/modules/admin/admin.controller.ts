import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../db/client.js";

const SALT_ROUNDS = 12;

const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  isAdmin: true,
  isActive: true,
  maxSessions: true,
  createdAt: true,
  _count: { select: { sessions: { where: { deletedAt: null } } } },
} as const;

function flattenCount(user: { _count: { sessions: number }; [key: string]: unknown }) {
  const { _count, ...rest } = user;
  return { ...rest, sessionCount: _count.sessions };
}

export async function handleListUsers(_request: FastifyRequest, reply: FastifyReply) {
  const users = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return reply.send({ users: users.map(flattenCount) });
}

export async function handleCreateUser(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const schema = z.object({
    username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_]+$/),
    email: z.string().email(),
    password: z.string().min(12),
    isAdmin: z.boolean().default(false),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const { username, email, password, isAdmin } = parsed.data;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existing) {
    return reply.status(409).send({ error: "Username or email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { username, email, passwordHash, isAdmin },
    select: USER_SELECT,
  });
  return reply.status(201).send({ user: flattenCount(user) });
}

export async function handleUpdateUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const schema = z.object({
    maxSessions: z.number().int().min(0).optional(),
    isAdmin: z.boolean().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const { id } = request.params;

  if (parsed.data.isActive === false && id === request.user.sub) {
    return reply.status(400).send({ error: "Cannot suspend your own account" });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return reply.status(404).send({ error: "User not found" });

  if (parsed.data.isAdmin === false && target.isAdmin) {
    const adminCount = await prisma.user.count({ where: { isAdmin: true } });
    if (adminCount <= 1) {
      return reply.status(400).send({ error: "Cannot remove the last admin" });
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: parsed.data,
    select: USER_SELECT,
  });
  return reply.send({ user: flattenCount(updated) });
}

export async function handleResetPassword(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const schema = z.object({ password: z.string().min(8) });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const { id } = request.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return reply.status(404).send({ error: "User not found" });

  const passwordHash = await bcrypt.hash(parsed.data.password, SALT_ROUNDS);
  await prisma.user.update({ where: { id }, data: { passwordHash } });
  return reply.send({ success: true });
}

export async function handleDeleteUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;

  if (id === request.user.sub) {
    return reply.status(400).send({ error: "Cannot delete your own account" });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return reply.status(404).send({ error: "User not found" });

  if (target.isAdmin) {
    const adminCount = await prisma.user.count({ where: { isAdmin: true } });
    if (adminCount <= 1) {
      return reply.status(400).send({ error: "Cannot delete the last admin" });
    }
  }

  await prisma.user.delete({ where: { id } });
  return reply.status(204).send();
}

export async function handleListAllSessions(
  _request: FastifyRequest,
  reply: FastifyReply
) {
  const sessions = await prisma.session.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      lastActiveAt: true,
      expiresAt: true,
      user: { select: { id: true, username: true, email: true } },
      _count: { select: { events: true } },
    },
    orderBy: { lastActiveAt: "desc" },
  });

  return reply.send({
    sessions: sessions.map(({ _count, ...s }) => ({ ...s, eventCount: _count.events })),
  });
}

export async function handleGetUserSessions(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return reply.status(404).send({ error: "User not found" });

  const sessions = await prisma.session.findMany({
    where: { userId: id, deletedAt: null },
    select: { id: true, name: true, status: true, createdAt: true, lastActiveAt: true },
    orderBy: { lastActiveAt: "desc" },
    take: 20,
  });
  return reply.send({ sessions });
}
