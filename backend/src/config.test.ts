import test from "node:test";
import assert from "node:assert/strict";

const REQUIRED_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
};

Object.assign(process.env, REQUIRED_ENV, { NODE_ENV: "test" });

const { parseEnv } = await import("./config.js");

test("parseEnv applies safe defaults", () => {
  const parsed = parseEnv(REQUIRED_ENV);

  assert.equal(parsed.PORT, 24710);
  assert.equal(parsed.DOCKER_NETWORK_NAME, "browsermint-internal");
  assert.equal(parsed.REGISTRATION_MODE, "open");
  assert.equal(parsed.DEFAULT_USER_MAX_SESSIONS, 2);
  assert.equal(parsed.COOKIE_SECURE, true);
  assert.equal(parsed.IDLE_PAUSE_ENABLED, true);
  assert.equal(parsed.SESSION_TOKEN_EXPIRY, "180d");
});

test("parseEnv handles boolean-like environment values explicitly", () => {
  assert.equal(parseEnv({ ...REQUIRED_ENV, COOKIE_SECURE: "false" }).COOKIE_SECURE, false);
  assert.equal(parseEnv({ ...REQUIRED_ENV, COOKIE_SECURE: "0" }).COOKIE_SECURE, false);
  assert.equal(parseEnv({ ...REQUIRED_ENV, COOKIE_SECURE: "true" }).COOKIE_SECURE, true);
  assert.equal(parseEnv({ ...REQUIRED_ENV, COOKIE_SECURE: "1" }).COOKIE_SECURE, true);
  assert.equal(parseEnv({ ...REQUIRED_ENV, IDLE_PAUSE_ENABLED: "0" }).IDLE_PAUSE_ENABLED, false);
});

test("parseEnv rejects invalid security and quota settings", () => {
  assert.throws(() => parseEnv({ ...REQUIRED_ENV, JWT_SECRET: "short" }));
  assert.throws(() => parseEnv({ ...REQUIRED_ENV, JWT_SESSION_TOKEN_SECRET: "short" }));
  assert.throws(() => parseEnv({ ...REQUIRED_ENV, DEFAULT_USER_MAX_SESSIONS: "-1" }));
  assert.throws(() => parseEnv({ ...REQUIRED_ENV, REGISTRATION_MODE: "invite-only" }));
});
