import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { config } from "./config.js";
import { prisma } from "./db/client.js";
import authRoutes from "./modules/auth/auth.routes.js";
import sessionsRoutes from "./modules/sessions/sessions.routes.js";
import { handleBrowserProxy } from "./services/proxy.service.js";
import { handleWebSocketUpgrade } from "./services/proxy.service.js";
import { reconcileContainers, pullImageIfNeeded } from "./services/docker.service.js";
import { authMiddleware } from "./middleware/auth.middleware.js";

const server = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
  },
});

await server.register(cors, {
  origin: true,
  credentials: true,
});
await server.register(sensible);

// ─── Routes ───────────────────────────────────────────────────────────────────

await server.register(authRoutes, { prefix: "/api/auth" });
await server.register(sessionsRoutes, { prefix: "/api/sessions" });

// Browser proxy endpoint (session-token auth via query string)
server.get("/api/sessions/:id/browser", {
  handler: async (request, reply) =>
    handleBrowserProxy(
      request as Parameters<typeof handleBrowserProxy>[0],
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

server.addHook("onReady", async () => {
  server.log.info("Reconciling containers...");
  await reconcileContainers().catch((err) =>
    server.log.warn({ err }, "Container reconcile failed")
  );

  server.log.info("Pulling steel-browser image...");
  await pullImageIfNeeded().catch((err) =>
    server.log.warn({ err }, "Image pull failed")
  );
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
