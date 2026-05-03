import test from "node:test";
import assert from "node:assert/strict";
import {
  daysUntilExpiry,
  effectiveOnlineMs,
  formatOnlineTimeBrief,
  formatOnlineTimeFull,
} from "./overview.helpers.ts";
import type { Session } from "../api/client.ts";

const BASE_SESSION: Session = {
  id: "s1",
  userId: "u1",
  name: null,
  status: "stopped",
  containerId: null,
  containerName: null,
  internalApiUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  deletedAt: null,
  onlineMs: 0,
  runningStartedAt: null,
};

test("daysUntilExpiry returns null or a rounded-up day count", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-01-01T00:00:00.000Z");
  try {
    assert.equal(daysUntilExpiry(null), null);
    assert.equal(daysUntilExpiry("2026-01-01T12:00:00.000Z"), 1);
    assert.equal(daysUntilExpiry("2026-01-03T00:00:00.000Z"), 2);
  } finally {
    Date.now = originalNow;
  }
});

test("online time formatters produce compact labels", () => {
  assert.equal(formatOnlineTimeBrief(0), "0m");
  assert.equal(formatOnlineTimeBrief(65 * 60 * 1000), "1h 5m");
  assert.equal(formatOnlineTimeBrief(26 * 60 * 60 * 1000), "1d 2h");
  assert.equal(formatOnlineTimeFull(90_000), "1m 30s");
  assert.equal(formatOnlineTimeFull(3_610_000), "1h 0m");
});

test("effectiveOnlineMs includes active running duration and ignores future starts", () => {
  assert.equal(effectiveOnlineMs({ ...BASE_SESSION, onlineMs: 5000 }, 100_000), 5000);
  assert.equal(
    effectiveOnlineMs({
      ...BASE_SESSION,
      status: "running",
      onlineMs: 5000,
      runningStartedAt: new Date(90_000).toISOString(),
    }, 100_000),
    15_000
  );
  assert.equal(
    effectiveOnlineMs({
      ...BASE_SESSION,
      status: "running",
      onlineMs: 5000,
      runningStartedAt: new Date(110_000).toISOString(),
    }, 100_000),
    5000
  );
});
