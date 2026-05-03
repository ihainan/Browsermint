import test from "node:test";
import assert from "node:assert/strict";
import {
  formatLogMessage,
  getCachedSessionToken,
  normalizeIncomingLogs,
  normalizeWsUrl,
  parseRichText,
  setCachedSessionToken,
  tokenizeJson,
  tokenizeShell,
} from "./sessionView.helpers.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

const storage = new MemoryStorage();

Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: { location: { protocol: "http:" } },
  configurable: true,
});

function makeJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("normalizeIncomingLogs keeps valid events and generates stable fallback ids", () => {
  const logs = normalizeIncomingLogs(JSON.stringify([
    { timestamp: "2026-01-01T00:00:00Z", type: "Console", pageId: "page-1", console: { text: "hello" } },
    { timestamp: "2026-01-01T00:00:01Z" },
  ]));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, "2026-01-01T00:00:00Z-Console-page-1-0");
  assert.equal(logs[0].type, "Console");
});

test("formatLogMessage formats known log payloads without leaking raw JSON noise", () => {
  assert.equal(
    formatLogMessage({
      id: "1",
      timestamp: "now",
      type: "Console",
      text: "raw",
      payload: { console: { text: "12:34:56.789 INFO hello\nworld" } },
    }),
    "hello world"
  );
  assert.equal(
    formatLogMessage({
      id: "2",
      timestamp: "now",
      type: "Request",
      text: "raw",
      payload: { request: { method: "POST", url: "https://example.com" } },
    }),
    "[POST] https://example.com"
  );
  assert.equal(
    formatLogMessage({
      id: "3",
      timestamp: "now",
      type: "Response",
      text: "raw",
      payload: { response: { status: 201, url: "https://example.com" } },
    }),
    "[201] https://example.com"
  );
});

test("cached session token helper returns valid tokens and removes expired ones", () => {
  storage.clear();
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  try {
    const validToken = makeJwt({ exp: 3_000 });
    setCachedSessionToken("s1", validToken);
    assert.equal(getCachedSessionToken("s1"), validToken);

    const expiredToken = makeJwt({ exp: 1 });
    setCachedSessionToken("s2", expiredToken);
    assert.equal(getCachedSessionToken("s2"), null);
    assert.equal(storage.getItem("session-token-s2"), null);

    setCachedSessionToken("s3", "not-a-jwt");
    assert.equal(getCachedSessionToken("s3"), null);
  } finally {
    Date.now = originalNow;
  }
});

test("normalizeWsUrl upgrades ws URLs only on HTTPS pages", () => {
  Object.defineProperty(globalThis, "window", { value: { location: { protocol: "https:" } }, configurable: true });
  assert.equal(normalizeWsUrl("ws://example.com/ws"), "wss://example.com/ws");
  assert.equal(normalizeWsUrl("wss://example.com/ws"), "wss://example.com/ws");

  Object.defineProperty(globalThis, "window", { value: { location: { protocol: "http:" } }, configurable: true });
  assert.equal(normalizeWsUrl("ws://example.com/ws"), "ws://example.com/ws");
});

test("parseRichText tokenizes supported markdown-like fragments", () => {
  assert.deepEqual(parseRichText("Use **bold**, `code`, and [docs](https://example.com)."), [
    { type: "text", value: "Use " },
    { type: "bold", value: "bold" },
    { type: "text", value: ", " },
    { type: "code", value: "code" },
    { type: "text", value: ", and " },
    { type: "link", value: "docs", href: "https://example.com" },
    { type: "text", value: "." },
  ]);
});

test("tokenizers identify JSON and shell token classes used by code highlighting", () => {
  assert.deepEqual(
    tokenizeJson('{"ok": true, "n": 12}').filter((token) => token.type !== "plain"),
    [
      { type: "punct", value: "{" },
      { type: "key", value: "\"ok\"" },
      { type: "punct", value: ":" },
      { type: "boolean", value: "true" },
      { type: "punct", value: "," },
      { type: "key", value: "\"n\"" },
      { type: "punct", value: ":" },
      { type: "number", value: "12" },
      { type: "punct", value: "}" },
    ]
  );

  assert.deepEqual(tokenizeShell('cmd --flag=value "quoted"').filter((token) => token.value.trim()).map((token) => token.type), [
    "plain",
    "number",
    "plain",
    "string",
  ]);
});
