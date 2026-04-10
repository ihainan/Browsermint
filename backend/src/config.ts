import { z } from "zod";

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
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  IDLE_PAUSE_ENABLED: z.coerce.boolean().default(true),
  IDLE_PAUSE_TIMEOUT_MS: z.coerce.number().default(10 * 60 * 1000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten());
  process.exit(1);
}

export const config = parsed.data;
