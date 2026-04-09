import { FastifyInstance } from "fastify";
import { adminMiddleware } from "../../middleware/auth.middleware.js";
import {
  handleListUsers,
  handleUpdateUser,
  handleDeleteUser,
} from "./admin.controller.js";

export default async function adminRoutes(server: FastifyInstance) {
  server.get("/users", { preHandler: adminMiddleware, handler: handleListUsers });
  server.patch("/users/:id", { preHandler: adminMiddleware, handler: handleUpdateUser });
  server.delete("/users/:id", { preHandler: adminMiddleware, handler: handleDeleteUser });
}
