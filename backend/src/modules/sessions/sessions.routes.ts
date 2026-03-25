import { FastifyInstance } from "fastify";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { CreateSessionBodySchema } from "./sessions.schema.js";
import {
  handleCreateSession,
  handleCreateSessionToken,
  handleDeleteSession,
  handleGetSession,
  handleListSessions,
} from "./sessions.controller.js";

export default async function sessionsRoutes(server: FastifyInstance) {
  server.addHook("preHandler", authMiddleware);

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

  server.post("/:id/token", {
    handler: async (request, reply) =>
      handleCreateSessionToken(
        request as Parameters<typeof handleCreateSessionToken>[0],
        reply
      ),
  });
}
