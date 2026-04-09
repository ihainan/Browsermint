import { FastifyInstance } from "fastify";
import { handleLogin, handleMe, handleRegister } from "./auth.controller.js";
import { LoginBodySchema, RegisterBodySchema } from "./auth.schema.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";

export default async function authRoutes(server: FastifyInstance) {
  server.post("/register", {
    schema: { body: { type: "object" } },
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 hour",
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Too many registration attempts, please try again later.",
        }),
      },
    },
    handler: async (request, reply) => {
      const parsed = RegisterBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      return handleRegister(
        request as Parameters<typeof handleRegister>[0],
        reply
      );
    },
  });

  server.post("/login", {
    schema: { body: { type: "object" } },
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "15 minutes",
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Too many login attempts, please try again later.",
        }),
      },
    },
    handler: async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      return handleLogin(
        request as Parameters<typeof handleLogin>[0],
        reply
      );
    },
  });

  server.get("/me", {
    preHandler: authMiddleware,
    handler: handleMe,
  });
}
