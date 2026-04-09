import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";

const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  isAdmin: true,
  maxSessions: true,
  createdAt: true,
  _count: { select: { sessions: { where: { deletedAt: null } } } },
} as const;

export async function handleListUsers(
  _request: FastifyRequest,
  reply: FastifyReply
) {
  const users = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return reply.send({ users: users.map(flattenCount) });
}

export async function handleUpdateUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const schema = z.object({
    maxSessions: z.number().int().min(0).optional(),
    isAdmin: z.boolean().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const { id } = request.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return reply.status(404).send({ error: "User not found" });
  }

  // Prevent the last admin from losing admin rights
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

export async function handleDeleteUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = request.params;

  if (id === request.user.sub) {
    return reply.status(400).send({ error: "Cannot delete your own account" });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return reply.status(404).send({ error: "User not found" });
  }

  if (target.isAdmin) {
    const adminCount = await prisma.user.count({ where: { isAdmin: true } });
    if (adminCount <= 1) {
      return reply.status(400).send({ error: "Cannot delete the last admin" });
    }
  }

  await prisma.user.delete({ where: { id } });
  return reply.status(204).send();
}

function flattenCount(user: {
  _count: { sessions: number };
  [key: string]: unknown;
}) {
  const { _count, ...rest } = user;
  return { ...rest, sessionCount: _count.sessions };
}
