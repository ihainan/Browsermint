import { FastifyInstance } from "fastify";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { CreateSessionBodySchema } from "./sessions.schema.js";
import {
  handleCreateSession,
  handleCreateSessionToken,
  handleRefreshSessionToken,
  handleDeleteSession,
  handleGetSession,
  handleListSessions,
  handleStartSession,
  handleStopSession,
  handleListSessionEvents,
  handleGetEventsStats,
} from "./sessions.controller.js";

export default async function sessionsRoutes(server: FastifyInstance) {
  server.addHook("preHandler", authMiddleware);

  // Static routes first to prevent /:id capturing them
  server.get("/events/stats", { handler: handleGetEventsStats });

  server.post("/", {
    schema: { body: { type: "object" } },
    handler: async (request, reply) => {
      const parsed = CreateSessionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      return handleCreateSession(
        request as Parameters<typeof handleCreateSession>[0],
        reply
      );
    },
  });

  server.get("/", { handler: handleListSessions });

  server.get("/:id", {
    handler: async (request, reply) =>
      handleGetSession(
        request as Parameters<typeof handleGetSession>[0],
        reply
      ),
  });

  server.delete("/:id", {
    handler: async (request, reply) =>
      handleDeleteSession(
        request as Parameters<typeof handleDeleteSession>[0],
        reply
      ),
  });

  server.post("/:id/stop", {
    handler: async (request, reply) =>
      handleStopSession(
        request as Parameters<typeof handleStopSession>[0],
        reply
      ),
  });

  server.post("/:id/start", {
    handler: async (request, reply) =>
      handleStartSession(
        request as Parameters<typeof handleStartSession>[0],
        reply
      ),
  });

  server.post("/:id/token", {
    handler: async (request, reply) =>
      handleCreateSessionToken(
        request as Parameters<typeof handleCreateSessionToken>[0],
        reply
      ),
  });

  server.post("/:id/refresh-token", {
    handler: async (request, reply) =>
      handleRefreshSessionToken(
        request as Parameters<typeof handleRefreshSessionToken>[0],
        reply
      ),
  });

  server.get("/:id/events", {
    handler: async (request, reply) =>
      handleListSessionEvents(
        request as Parameters<typeof handleListSessionEvents>[0],
        reply
      ),
  });
}
