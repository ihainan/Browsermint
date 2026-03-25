import { FastifyInstance } from "fastify";
import { handleLogin, handleMe, handleRegister } from "./auth.controller.js";
import { LoginBodySchema, RegisterBodySchema } from "./auth.schema.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";

export default async function authRoutes(server: FastifyInstance) {
  server.post("/register", {
    schema: { body: { type: "object" } },
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
