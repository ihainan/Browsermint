import { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export function bindPrismaLogger(logger: FastifyBaseLogger) {
  prisma.$on("query", (e) => logger.debug({ query: e.query, duration: e.duration }, "prisma query"));
  prisma.$on("warn",  (e) => logger.warn({ message: e.message }, "prisma warn"));
  prisma.$on("error", (e) => logger.error({ message: e.message }, "prisma error"));
}
