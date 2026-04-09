import { FastifyInstance } from "fastify";
import { adminMiddleware } from "../../middleware/auth.middleware.js";
import {
  handleListUsers,
  handleCreateUser,
  handleUpdateUser,
  handleResetPassword,
  handleDeleteUser,
  handleGetUserSessions,
  handleListAllSessions,
} from "./admin.controller.js";

export default async function adminRoutes(server: FastifyInstance) {
  server.get("/users", { preHandler: adminMiddleware, handler: handleListUsers });
  server.post("/users", { preHandler: adminMiddleware, handler: handleCreateUser });
  server.patch("/users/:id", { preHandler: adminMiddleware, handler: handleUpdateUser });
  server.post("/users/:id/reset-password", { preHandler: adminMiddleware, handler: handleResetPassword });
  server.delete("/users/:id", { preHandler: adminMiddleware, handler: handleDeleteUser });
  server.get("/users/:id/sessions", { preHandler: adminMiddleware, handler: handleGetUserSessions });
  server.get("/sessions", { preHandler: adminMiddleware, handler: handleListAllSessions });
}
