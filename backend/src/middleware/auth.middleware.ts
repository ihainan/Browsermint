import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prisma } from "../db/client.js";

export interface JwtPayload {
  sub: string;
  username: string;
  isAdmin: boolean;
  iat: number;
  exp: number;
}

declare module "fastify" {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  // Prefer HttpOnly cookie (browser clients) — JS cannot read this, preventing XSS theft.
  // Fall back to Authorization header for programmatic API clients (curl, scripts, etc.).
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)browsermint_auth=([^;]*)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return undefined;
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const token = extractToken(request);
  if (!token) return reply.status(401).send({ error: "Unauthorized" });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true },
    });
    if (!user?.isActive) return reply.status(401).send({ error: "Unauthorized" });
    request.user = payload;
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

export async function adminMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  await authMiddleware(request, reply);
  if (reply.sent) return;
  if (!request.user.isAdmin) {
    return reply.status(403).send({ error: "Forbidden" });
  }
}
