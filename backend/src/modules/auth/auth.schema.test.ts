import test from "node:test";
import assert from "node:assert/strict";
import { LoginBodySchema, RegisterBodySchema } from "./auth.schema.js";

test("RegisterBodySchema accepts valid registration payloads", () => {
  const parsed = RegisterBodySchema.parse({
    username: "agent_user_01",
    email: "agent@example.com",
    password: "password123",
  });

  assert.equal(parsed.username, "agent_user_01");
});

test("RegisterBodySchema rejects unsafe or incomplete registration payloads", () => {
  assert.equal(RegisterBodySchema.safeParse({ username: "ab", email: "a@example.com", password: "password123" }).success, false);
  assert.equal(RegisterBodySchema.safeParse({ username: "bad-name", email: "a@example.com", password: "password123" }).success, false);
  assert.equal(RegisterBodySchema.safeParse({ username: "valid_name", email: "not-email", password: "password123" }).success, false);
  assert.equal(RegisterBodySchema.safeParse({ username: "valid_name", email: "a@example.com", password: "short" }).success, false);
});

test("LoginBodySchema requires an email and non-empty password", () => {
  assert.equal(LoginBodySchema.safeParse({ email: "agent@example.com", password: "x" }).success, true);
  assert.equal(LoginBodySchema.safeParse({ email: "agent", password: "x" }).success, false);
  assert.equal(LoginBodySchema.safeParse({ email: "agent@example.com", password: "" }).success, false);
});
