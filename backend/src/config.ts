import { z } from "zod";

// z.coerce.boolean() uses Boolean(value), so Boolean("false") === true.
// This helper correctly maps "false"/"0" → false and "true"/"1" → true.
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => v === "false" || v === "0" ? false : v === "true" || v === "1" ? true : undefined,
    z.boolean().default(defaultVal)
  );

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_SESSION_TOKEN_SECRET: z.string().min(16),
  // Engine that runs the per-session browser workloads. "docker" creates
  // containers via /var/run/docker.sock (compose deployments); "kubernetes"
  // creates a Pod + per-session Service + profile PVC in K8S_NAMESPACE.
  SESSION_DRIVER: z.enum(["docker", "kubernetes"]).default("docker"),
  DOCKER_NETWORK_NAME: z.string().default("browsermint-internal"),
  STEEL_BROWSER_IMAGE: z
    .string()
    .default("ghcr.io/steel-dev/steel-browser-api:latest"),
  K8S_NAMESPACE: z.string().default("browsermint"),
  K8S_STORAGE_CLASS: z.string().default("nfs-harbor"),
  K8S_PVC_SIZE: z.string().default("2Gi"),
  K8S_SHM_SIZE: z.string().default("1Gi"),
  K8S_SESSION_CPU_REQUEST: z.string().default("500m"),
  K8S_SESSION_CPU_LIMIT: z.string().default("2"),
  K8S_SESSION_MEMORY_REQUEST: z.string().default("1Gi"),
  K8S_SESSION_MEMORY_LIMIT: z.string().default("2Gi"),
  // Name of the imagePullSecret for the browser image registry (optional).
  K8S_IMAGE_PULL_SECRET: z.string().optional(),
  // How long a session pod may take to schedule + pull + become Ready.
  K8S_POD_START_TIMEOUT_MS: z.coerce.number().default(120_000),
  PORT: z.coerce.number().default(24710),
  CAPSOLVER_API_KEY: z.string().optional(),
  REGISTRATION_MODE: z.enum(["open", "disabled"]).default("open"),
  // Default maxSessions for newly created users. 0 means unlimited.
  DEFAULT_USER_MAX_SESSIONS: z.coerce.number().int().min(0).default(2),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  IDLE_PAUSE_ENABLED: boolEnv(true),
  IDLE_PAUSE_TIMEOUT_MS: z.coerce.number().default(10 * 60 * 1000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // Set to false when serving over plain HTTP (e.g. no TLS terminator in front).
  // Defaults to true in production so the auth cookie is Secure by default.
  COOKIE_SECURE: boolEnv(true),
  // Expiry for session WebSocket JWT tokens (e.g. "180d", "365d", "30d").
  SESSION_TOKEN_EXPIRY: z.string().default("180d"),
  // Shared secret authorizing POST /api/service/agent-tokens (the agent
  // platform integration). Unset → the service API is not registered at all.
  SERVICE_ASSERTION_SECRET: z.string().min(16).optional(),
  // Expiry for auth tokens minted through the service API.
  SERVICE_AGENT_TOKEN_EXPIRY: z.string().default("180d"),
});

export function parseEnv(env: NodeJS.ProcessEnv) {
  return envSchema.parse(env);
}

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten());
  process.exit(1);
}

export const config = parsed.data;
