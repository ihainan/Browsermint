import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

const prismaClientOptions = {
  log: [
    { emit: "event", level: "query" },
    { emit: "event", level: "error" },
    { emit: "event", level: "warn" },
  ],
} satisfies Prisma.PrismaClientOptions;

export type AppPrismaClient = PrismaClient<typeof prismaClientOptions>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export let prisma: AppPrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient(prismaClientOptions);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export function bindPrismaLogger(logger: FastifyBaseLogger) {
  if (typeof prisma.$on !== "function") return;
  prisma.$on("query", (e) => logger.debug({ query: e.query, duration: e.duration }, "prisma query"));
  prisma.$on("warn",  (e) => logger.warn({ message: e.message }, "prisma warn"));
  prisma.$on("error", (e) => logger.error({ message: e.message }, "prisma error"));
}

export function setPrismaForTests(testPrisma: AppPrismaClient): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setPrismaForTests can only be used when NODE_ENV=test");
  }
  prisma = testPrisma;
}
