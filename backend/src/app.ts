import Fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import staticFiles from "@fastify/static";
import { createRequire } from "module";
import { dirname } from "path";
import { config } from "./config.js";
import { bindPrismaLogger } from "./db/client.js";
import authRoutes from "./modules/auth/auth.routes.js";
import sessionsRoutes from "./modules/sessions/sessions.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import {
  handleActivateTarget,
  handleBrowserProxy,
  handleCloseTarget,
  handleCreateTarget,
  handleDetailsProxy,
  handleDevtoolsProxy,
  handleDevtoolsTargetProxy,
  handleGetTargets,
  handleGoBack,
  handleGoForward,
  handleNavigate,
  handleReload,
  handleSetClipboard,
  handleVncViewer,
  handleWebSocketUpgrade,
} from "./services/proxy.service.js";

export interface CreateAppOptions {
  logger?: FastifyServerOptions["logger"];
  serveStatic?: boolean;
}

export function redactTokenFromUrl(url: string): string {
  return url.replace(/([?&])token=[^&]*/g, "$1[redacted]").replace(/[?&]$/, "");
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: options.logger ?? {
      level: config.LOG_LEVEL,
      transport: config.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } }
        : undefined,
    },
    disableRequestLogging: true,
  });

  bindPrismaLogger(server.log);

  server.addHook("onRequest", async (request) => {
    request.log.debug({ method: request.method, url: redactTokenFromUrl(request.url) }, "incoming request");
  });
  server.addHook("onResponse", async (request, reply) => {
    request.log.debug(
      { method: request.method, url: redactTokenFromUrl(request.url), statusCode: reply.statusCode, responseTime: reply.elapsedTime },
      "request completed"
    );
  });

  await server.register(cors, {
    origin: true,
    credentials: true,
  });
  await server.register(rateLimit, { global: false });
  await server.register(sensible);

  if (options.serveStatic !== false) {
    const _require = createRequire(import.meta.url);
    const novncDir = dirname(_require.resolve("@novnc/novnc/package.json"));
    await server.register(staticFiles, {
      root: novncDir,
      prefix: "/novnc/",
      decorateReply: false,
    });
  }

  await server.register(authRoutes, { prefix: "/api/auth" });
  await server.register(sessionsRoutes, { prefix: "/api/sessions" });
  await server.register(adminRoutes, { prefix: "/api/admin" });

  server.get("/api/sessions/:id/details", {
    handler: async (request, reply) =>
      handleDetailsProxy(
        request as Parameters<typeof handleDetailsProxy>[0],
        reply
      ),
  });

  server.get("/api/sessions/:id/browser", {
    handler: async (request, reply) =>
      handleBrowserProxy(
        request as Parameters<typeof handleBrowserProxy>[0],
        reply
      ),
  });

  server.post("/api/sessions/:id/clipboard", {
    handler: async (request, reply) =>
      handleSetClipboard(
        request as Parameters<typeof handleSetClipboard>[0],
        reply
      ),
  });

  server.get("/api/sessions/:id/vnc-viewer", {
    handler: async (request, reply) =>
      handleVncViewer(
        request as Parameters<typeof handleVncViewer>[0],
        reply
      ),
  });

  server.get("/api/sessions/:id/devtools/*", {
    handler: async (request, reply) =>
      handleDevtoolsProxy(
        request as Parameters<typeof handleDevtoolsProxy>[0],
        reply
      ),
  });

  server.get("/api/sessions/:id/devtools-target", {
    handler: async (request, reply) =>
      handleDevtoolsTargetProxy(
        request as Parameters<typeof handleDevtoolsTargetProxy>[0],
        reply
      ),
  });

  server.get("/api/sessions/:id/targets", {
    handler: async (request, reply) =>
      handleGetTargets(request as Parameters<typeof handleGetTargets>[0], reply),
  });
  server.post("/api/sessions/:id/targets", {
    handler: async (request, reply) =>
      handleCreateTarget(request as Parameters<typeof handleCreateTarget>[0], reply),
  });
  server.delete("/api/sessions/:id/targets/:targetId", {
    handler: async (request, reply) =>
      handleCloseTarget(request as Parameters<typeof handleCloseTarget>[0], reply),
  });
  server.post("/api/sessions/:id/targets/:targetId/activate", {
    handler: async (request, reply) =>
      handleActivateTarget(request as Parameters<typeof handleActivateTarget>[0], reply),
  });
  server.post("/api/sessions/:id/navigate", {
    handler: async (request, reply) =>
      handleNavigate(request as Parameters<typeof handleNavigate>[0], reply),
  });
  server.post("/api/sessions/:id/go-back", {
    handler: async (request, reply) =>
      handleGoBack(request as Parameters<typeof handleGoBack>[0], reply),
  });
  server.post("/api/sessions/:id/go-forward", {
    handler: async (request, reply) =>
      handleGoForward(request as Parameters<typeof handleGoForward>[0], reply),
  });
  server.post("/api/sessions/:id/reload", {
    handler: async (request, reply) =>
      handleReload(request as Parameters<typeof handleReload>[0], reply),
  });

  server.get("/health", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  server.server.on("upgrade", (request, socket, head) => {
    handleWebSocketUpgrade(request, socket, head).catch((err) => {
      server.log.error({ err }, "WebSocket upgrade error");
      socket.destroy();
    });
  });

  return server;
}
