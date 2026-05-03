import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const {
  getRequestProtocols,
  parseSessionWebSocketPath,
  rewriteUpstreamWebSocketUrl,
  sanitizeRequestPath,
} = await import("./proxy.service.js");

test("sanitizeRequestPath removes token without dropping other query params", () => {
  assert.equal(sanitizeRequestPath("/api/sessions/s1/details?token=secret&page=1"), "/api/sessions/s1/details?page=1");
  assert.equal(sanitizeRequestPath("/api/sessions/s1/details?page=1&token=secret"), "/api/sessions/s1/details?page=1");
  assert.equal(sanitizeRequestPath("/api/sessions/s1/details?token=secret"), "/api/sessions/s1/details");
});

test("getRequestProtocols trusts forwarded proto before origin or referer", () => {
  assert.deepEqual(getRequestProtocols({ headers: { "x-forwarded-proto": "https" } }), { http: "https", ws: "wss" });
  assert.deepEqual(getRequestProtocols({ headers: { origin: "https://app.example" } }), { http: "https", ws: "wss" });
  assert.deepEqual(getRequestProtocols({ headers: { referer: "http://app.example/path" } }), { http: "http", ws: "ws" });
});

test("parseSessionWebSocketPath parses standard and double-question-mark URLs", () => {
  assert.deepEqual(parseSessionWebSocketPath("/ws/sessions/s1/cdp/devtools/page/1?token=t1"), {
    sessionId: "s1",
    wsType: "cdp",
    wsSubPath: "/devtools/page/1",
    token: "t1",
  });

  assert.deepEqual(parseSessionWebSocketPath("/ws/sessions/s1/cast?token=t1?pageId=p1"), {
    sessionId: "s1",
    wsType: "cast",
    wsSubPath: "/",
    token: "t1",
  });

  assert.equal(parseSessionWebSocketPath("/not/a/session/path"), null);
});

test("rewriteUpstreamWebSocketUrl keeps CDP subpath while routing through Browsermint", () => {
  const rewritten = rewriteUpstreamWebSocketUrl(
    { headers: { host: "browsermint.example", "x-forwarded-proto": "https" } },
    "session-1",
    "session-token",
    "ws://172.18.0.2:9223/devtools/page/abc"
  );

  assert.equal(rewritten, "wss://browsermint.example/ws/sessions/session-1/cdp/devtools/page/abc?token=session-token");
});
