import test from "node:test";
import assert from "node:assert/strict";
import { CreateSessionBodySchema } from "./sessions.schema.js";

test("CreateSessionBodySchema accepts empty and named session creation", () => {
  assert.deepEqual(CreateSessionBodySchema.parse({}), {});
  assert.deepEqual(CreateSessionBodySchema.parse({ name: "Research browser" }), { name: "Research browser" });
});

test("CreateSessionBodySchema rejects overly long names", () => {
  assert.equal(CreateSessionBodySchema.safeParse({ name: "x".repeat(65) }).success, false);
});
