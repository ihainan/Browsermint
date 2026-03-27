import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { config } from "./config.js";
import { prisma, bindPrismaLogger } from "./db/client.js";
import authRoutes from "./modules/auth/auth.routes.js";
import sessionsRoutes from "./modules/sessions/sessions.routes.js";
import { handleBrowserProxy, handleDetailsProxy, handleDevtoolsProxy } from "./services/proxy.service.js";
import { handleWebSocketUpgrade } from "./services/proxy.service.js";
import { reconcileContainers, pullImageIfNeeded } from "./services/docker.service.js";
import { authMiddleware } from "./middleware/auth.middleware.js";

const server = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } }
      : undefined,
  },
  disableRequestLogging: true,
});

bindPrismaLogger(server.log);

// Log requests at debug level
server.addHook("onRequest", async (request) => {
  request.log.debug({ method: request.method, url: request.url }, "incoming request");
});
server.addHook("onResponse", async (request, reply) => {
  request.log.debug(
    { method: request.method, url: request.url, statusCode: reply.statusCode, responseTime: reply.elapsedTime },
    "request completed"
  );
});

await server.register(cors, {
  origin: true,
  credentials: true,
});
await server.register(sensible);

// ─── Routes ───────────────────────────────────────────────────────────────────

await server.register(authRoutes, { prefix: "/api/auth" });
await server.register(sessionsRoutes, { prefix: "/api/sessions" });

// Session details proxy (session-token auth via query string)
server.get("/api/sessions/:id/details", {
  handler: async (request, reply) =>
    handleDetailsProxy(
      request as Parameters<typeof handleDetailsProxy>[0],
      reply
    ),
});

// Browser proxy endpoint (session-token auth via query string)
server.get("/api/sessions/:id/browser", {
  handler: async (request, reply) =>
    handleBrowserProxy(
      request as Parameters<typeof handleBrowserProxy>[0],
      reply
    ),
});

// DevTools frontend asset proxy (session-token auth via query string)
server.get("/api/sessions/:id/devtools/*", {
  handler: async (request, reply) =>
    handleDevtoolsProxy(
      request as Parameters<typeof handleDevtoolsProxy>[0],
      reply
    ),
});

// Health check
server.get("/health", async (_request, reply) => {
  return reply.send({ status: "ok" });
});

// ─── WebSocket Upgrade ────────────────────────────────────────────────────────

server.server.on("upgrade", (request, socket, head) => {
  handleWebSocketUpgrade(request, socket, head).catch((err) => {
    server.log.error({ err }, "WebSocket upgrade error");
    socket.destroy();
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function runStartupTask(name: string, task: () => Promise<void>) {
  void task().catch((err) => {
    server.log.warn({ err }, `${name} failed`);
  });
}

server.addHook("onReady", async () => {
  server.log.info("Reconciling containers...");
  runStartupTask("Container reconcile", reconcileContainers);

  server.log.info("Pulling steel-browser image...");
  runStartupTask("Image pull", pullImageIfNeeded);
});

server.addHook("onClose", async () => {
  await prisma.$disconnect();
});

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
  server.log.info(`SteelYard backend listening on port ${config.PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
