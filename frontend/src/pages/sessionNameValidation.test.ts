import test from "node:test";
import assert from "node:assert/strict";
import {
  getSessionNameValidationError,
  getSessionNameValidationKey,
  type SessionNameValidationKey,
} from "./sessionNameValidation.ts";

const sessions = [
  { name: "Research" },
  { name: "  Trimmed Existing  " },
  { name: null },
];

test("getSessionNameValidationKey validates required, length, and duplicate names", () => {
  assert.equal(getSessionNameValidationKey("", sessions), "sessions.browserNameRequired");
  assert.equal(getSessionNameValidationKey("   ", sessions), "sessions.browserNameRequired");
  assert.equal(getSessionNameValidationKey("a".repeat(65), sessions), "sessions.browserNameTooLong");
  assert.equal(getSessionNameValidationKey("research", sessions), "sessions.browserNameDuplicate");
  assert.equal(getSessionNameValidationKey("trimmed existing", sessions), "sessions.browserNameDuplicate");
  assert.equal(getSessionNameValidationKey("New Browser", sessions), null);
});

test("getSessionNameValidationError maps validation keys through i18n", () => {
  const t = (key: SessionNameValidationKey) => `translated:${key}`;

  assert.equal(
    getSessionNameValidationError("research", sessions, t),
    "translated:sessions.browserNameDuplicate"
  );
  assert.equal(getSessionNameValidationError("New Browser", sessions, t), "");
});
