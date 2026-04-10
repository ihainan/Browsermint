import { z } from "zod";

// z.coerce.boolean() uses Boolean(value), so Boolean("false") === true.
// This helper correctly maps "false"/"0" → false and "true"/"1" → true.
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => v === "false" || v === "0" ? false : v === "true" || v === "1" ? true : undefined,
    z.boolean().default(defaultVal)
  );

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_SESSION_TOKEN_SECRET: z.string().min(16),
  DOCKER_NETWORK_NAME: z.string().default("browsermint-internal"),
  STEEL_BROWSER_IMAGE: z
    .string()
    .default("ghcr.io/steel-dev/steel-browser-api:latest"),
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
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten());
  process.exit(1);
}

export const config = parsed.data;
