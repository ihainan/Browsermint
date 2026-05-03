import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const { extractAuthToken } = await import("./auth.middleware.js");

test("extractAuthToken prefers the HttpOnly browser cookie", () => {
  const token = extractAuthToken({
    headers: {
      cookie: "theme=dark; browsermint_auth=cookie%20token; other=value",
      authorization: "Bearer bearer-token",
    },
  });

  assert.equal(token, "cookie token");
});

test("extractAuthToken falls back to bearer authorization", () => {
  const token = extractAuthToken({
    headers: { authorization: "Bearer bearer-token" },
  });

  assert.equal(token, "bearer-token");
});

test("extractAuthToken ignores unsupported authorization schemes", () => {
  assert.equal(extractAuthToken({ headers: { authorization: "Basic abc" } }), undefined);
  assert.equal(extractAuthToken({ headers: {} }), undefined);
});
