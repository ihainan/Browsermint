import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface JwtPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
}

declare module "fastify" {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    request.user = payload;
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}
