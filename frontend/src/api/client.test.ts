import test from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(globalThis, "window", {
  value: { location: { pathname: "/dashboard", href: "" } },
  configurable: true,
});

const { api } = await import("./client.ts");

function getRejectedInterceptor() {
  const handlers = (api.interceptors.response as unknown as {
    handlers: Array<{ rejected?: (error: unknown) => Promise<never> }>;
  }).handlers;
  const rejected = handlers.find((handler) => handler.rejected)?.rejected;
  assert.ok(rejected, "response interceptor should be registered");
  return rejected;
}

test("401 interceptor redirects protected API calls to login", async () => {
  window.location.pathname = "/dashboard";
  window.location.href = "";
  const rejected = getRejectedInterceptor();

  await assert.rejects(() => rejected({ response: { status: 401 }, config: { url: "/sessions" } }));

  assert.equal(window.location.href, "/login");
});

test("401 interceptor does not redirect session proxy failures", async () => {
  window.location.pathname = "/sessions/s1";
  window.location.href = "";
  const rejected = getRejectedInterceptor();

  await assert.rejects(() => rejected({ response: { status: 401 }, config: { url: "/sessions/s1/details?token=expired" } }));
  await assert.rejects(() => rejected({ response: { status: 401 }, config: { url: "/sessions/s1/devtools/devtools_app.html" } }));

  assert.equal(window.location.href, "");
});
