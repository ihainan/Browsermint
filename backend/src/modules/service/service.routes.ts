import { FastifyInstance } from "fastify";
import { handleMintAgentToken } from "./service.controller.js";

export default async function serviceRoutes(server: FastifyInstance) {
  server.post("/agent-tokens", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    handler: async (request, reply) =>
      handleMintAgentToken(request as Parameters<typeof handleMintAgentToken>[0], reply),
  });
}
