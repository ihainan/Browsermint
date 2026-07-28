import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/client.js";
import { config } from "../../config.js";

// Internal service API used by the ZGCAI Agent Platform to mint per-agent
// Browsermint accounts + long-lived Bearer tokens (same shape the Pages
// integration uses: a short-lived HS256 assertion signed with a shared
// secret authorizes exactly this endpoint, nothing else).

const ASSERTION_PURPOSE = "agent-token";
// Agent users may not log in with a password: this string can never match a
// bcrypt hash, so bcrypt.compare always fails while login timing stays constant.
const UNUSABLE_PASSWORD_HASH = "!service-account-no-password";

interface AssertionPayload {
  purpose?: string;
  act_for?: string;
  iss?: string;
}

function verifyAssertion(header: string | undefined): AssertionPayload | null {
  if (!header || !config.SERVICE_ASSERTION_SECRET) return null;
  try {
    const payload = jwt.verify(header, config.SERVICE_ASSERTION_SECRET) as AssertionPayload;
    if (payload.purpose !== ASSERTION_PURPOSE) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function handleMintAgentToken(
  request: FastifyRequest<{ Body: { agent_id?: unknown; max_sessions?: unknown } }>,
  reply: FastifyReply
) {
  const assertion = verifyAssertion(request.headers["x-service-assertion"] as string | undefined);
  if (!assertion) {
    return reply.status(401).send({ error: "Invalid service assertion" });
  }

  const agentId = request.body?.agent_id;
  if (typeof agentId !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(agentId)) {
    return reply.status(400).send({ error: "agent_id must match [a-zA-Z0-9_-]{1,48}" });
  }

  const username = `agent-${agentId}`;
  const email = `${username}@service.browsermint.internal`;
  const maxSessions =
    typeof request.body?.max_sessions === "number" && request.body.max_sessions >= 0
      ? Math.floor(request.body.max_sessions)
      : config.DEFAULT_USER_MAX_SESSIONS;

  const user = await prisma.user.upsert({
    where: { username },
    create: {
      username,
      email,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      isAdmin: false,
      maxSessions,
    },
    // Existing agent accounts keep their (possibly admin-tuned) maxSessions.
    update: {},
  });

  if (!user.isActive) {
    return reply.status(403).send({ error: "Agent account is deactivated" });
  }

  const token = jwt.sign(
    { sub: user.id, username: user.username, isAdmin: false },
    config.JWT_SECRET,
    { expiresIn: config.SERVICE_AGENT_TOKEN_EXPIRY as import("ms").StringValue }
  );

  console.info(
    `[service] Minted agent token for ${username} (act_for=${assertion.act_for ?? "-"})`
  );
  return reply.status(201).send({
    token,
    user_id: user.id,
    username: user.username,
    max_sessions: user.maxSessions,
  });
}
