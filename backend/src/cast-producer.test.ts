import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const { parseSessionWebSocketPath } = await import("./services/proxy.service.js");

// The viewer we serve is Steel's player, which appends its own params with "?"
// even when the base URL already has a query string. The parser has to survive
// that; a pagecast route that silently loses targetId would fail at attach time
// with no useful signal.
test("pagecast路由: 解析 targetId 与 token（含玩家的双问号拼接）", () => {
  const p = parseSessionWebSocketPath(
    "/ws/sessions/sess-1/pagecast?token=T&targetId=ABC?pageId=ABC");
  assert.equal(p?.wsType, "pagecast");
  assert.equal(p?.sessionId, "sess-1");
  assert.equal(p?.token, "T");
});

test("pagecast与被反代的cast是两条路由，互不影响", () => {
  assert.equal(parseSessionWebSocketPath("/ws/sessions/s/cast?token=T")?.wsType, "cast");
  assert.equal(parseSessionWebSocketPath("/ws/sessions/s/pagecast?token=T")?.wsType, "pagecast");
  // 未知类型不该被误当成 pagecast
  assert.equal(parseSessionWebSocketPath("/ws/sessions/s/bogus?token=T"), null);
});
