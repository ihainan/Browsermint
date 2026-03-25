import { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/client.js";
import { config } from "../../config.js";
import { RegisterBody, LoginBody } from "./auth.schema.js";

const SALT_ROUNDS = 12;
const AUTH_ERROR_MSG = "Invalid email or password";

function signToken(userId: string, username: string): string {
  return jwt.sign({ sub: userId, username }, config.JWT_SECRET, {
    expiresIn: "24h",
  });
}

export async function handleRegister(
  request: FastifyRequest<{ Body: RegisterBody }>,
  reply: FastifyReply
) {
  const { username, email, password } = request.body;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });
  if (existing) {
    return reply.status(409).send({ error: "Username or email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { username, email, passwordHash },
    select: { id: true, username: true, email: true, createdAt: true, maxSessions: true },
  });

  const token = signToken(user.id, user.username);
  return reply.status(201).send({ user, token });
}

export async function handleLogin(
  request: FastifyRequest<{ Body: LoginBody }>,
  reply: FastifyReply
) {
  const { email, password } = request.body;

  const user = await prisma.user.findUnique({ where: { email } });
  // Use constant-time compare even when user not found, to prevent timing attacks
  const hash = user?.passwordHash ?? "$2b$12$invalidhashfortimingattackprevention";
  const valid = await bcrypt.compare(password, hash);

  if (!user || !valid) {
    return reply.status(401).send({ error: AUTH_ERROR_MSG });
  }

  const token = signToken(user.id, user.username);
  return reply.send({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
      maxSessions: user.maxSessions,
    },
    token,
  });
}

export async function handleMe(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const user = await prisma.user.findUnique({
    where: { id: request.user.sub },
    select: { id: true, username: true, email: true, createdAt: true, maxSessions: true },
  });
  if (!user) {
    return reply.status(404).send({ error: "User not found" });
  }
  return reply.send({ user });
}
