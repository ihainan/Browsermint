import { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/client.js";
import { config } from "../../config.js";
import { RegisterBody, LoginBody } from "./auth.schema.js";

const SALT_ROUNDS = 12;
const AUTH_ERROR_MSG = "Invalid email or password";
const AUTH_COOKIE_NAME = "browsermint_auth";
const AUTH_COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours, matching JWT expiry

function signToken(userId: string, username: string, isAdmin: boolean): string {
  return jwt.sign({ sub: userId, username, isAdmin }, config.JWT_SECRET, {
    expiresIn: "24h",
  });
}

function setAuthCookie(reply: FastifyReply, token: string): void {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/api/",
    `Max-Age=${AUTH_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ];
  if (config.COOKIE_SECURE) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(reply: FastifyReply): void {
  reply.header(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; HttpOnly; Path=/api/; Max-Age=0; SameSite=Lax`
  );
}

export async function handleRegister(
  request: FastifyRequest<{ Body: RegisterBody }>,
  reply: FastifyReply
) {
  if (config.REGISTRATION_MODE === "disabled") {
    return reply.status(403).send({ error: "Registration is disabled" });
  }

  const { username, email, password } = request.body;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });
  if (existing) {
    return reply.status(409).send({ error: "Username or email already exists" });
  }

  const userCount = await prisma.user.count();
  const isAdmin = userCount === 0;

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { username, email, passwordHash, isAdmin },
    select: { id: true, username: true, email: true, isAdmin: true, createdAt: true, maxSessions: true },
  });

  const token = signToken(user.id, user.username, user.isAdmin);
  setAuthCookie(reply, token);
  return reply.status(201).send({ user });
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

  const token = signToken(user.id, user.username, user.isAdmin);
  setAuthCookie(reply, token);
  return reply.send({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
      maxSessions: user.maxSessions,
    },
  });
}

export async function handleMe(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const user = await prisma.user.findUnique({
    where: { id: request.user.sub },
    select: { id: true, username: true, email: true, isAdmin: true, createdAt: true, maxSessions: true },
  });
  if (!user) {
    return reply.status(404).send({ error: "User not found" });
  }
  return reply.send({ user });
}

export async function handleLogout(
  _request: FastifyRequest,
  reply: FastifyReply
) {
  clearAuthCookie(reply);
  return reply.send({ success: true });
}
