import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const { calcOnlineMsDelta } = await import("./sessions.controller.js");

test("calcOnlineMsDelta returns zero when no running start exists", () => {
  assert.equal(calcOnlineMsDelta(null), 0);
  assert.equal(calcOnlineMsDelta(undefined), 0);
});

test("calcOnlineMsDelta returns elapsed time and clamps future starts to zero", () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    assert.equal(calcOnlineMsDelta(new Date(999_000)), 1_000);
    assert.equal(calcOnlineMsDelta(new Date(1_001_000)), 0);
  } finally {
    Date.now = originalNow;
  }
});
