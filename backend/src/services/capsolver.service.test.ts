import test from "node:test";
import assert from "node:assert/strict";
import { solveCaptcha } from "./capsolver.service.js";

type FetchCall = { url: string; body: Record<string, unknown> };

function jsonResponse(data: unknown) {
  return { json: async () => data } as Response;
}

async function withMockedCapsolver(
  responses: unknown[],
  run: (calls: FetchCall[]) => Promise<void>
) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call");
    return jsonResponse(response);
  }) as typeof fetch;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
    callback(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("solveCaptcha creates a sanitized reCAPTCHA v2 task and extracts gRecaptchaResponse", async () => {
  await withMockedCapsolver([
    { errorId: 0, taskId: "task-1" },
    { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "captcha-token" } },
  ], async (calls) => {
    const result = await solveCaptcha(
      "recaptcha-v2",
      "site-key",
      "https://example.com/login?token=secret&solution=x&keep=1",
      "",
      "api-key",
      "Browsermint UA"
    );

    assert.deepEqual(result, { token: "captcha-token", taskId: "task-1" });
    assert.equal(calls[0].url, "https://api.capsolver.com/createTask");
    assert.deepEqual(calls[0].body, {
      clientKey: "api-key",
      task: {
        type: "ReCaptchaV2TaskProxyless",
        websiteURL: "https://example.com/login?keep=1",
        websiteKey: "site-key",
        userAgent: "Browsermint UA",
      },
    });
    assert.deepEqual(calls[1].body, { clientKey: "api-key", taskId: "task-1" });
  });
});

test("solveCaptcha maps Turnstile solutions from the token field", async () => {
  await withMockedCapsolver([
    { errorId: 0, taskId: "task-2" },
    { errorId: 0, status: "ready", solution: { token: "turnstile-token" } },
  ], async () => {
    const result = await solveCaptcha("turnstile", "site-key", "https://example.com", "", "api-key");

    assert.deepEqual(result, { token: "turnstile-token", taskId: "task-2" });
  });
});

test("solveCaptcha surfaces CapSolver createTask errors", async () => {
  await withMockedCapsolver([
    { errorId: 1, errorDescription: "bad key" },
  ], async () => {
    await assert.rejects(
      () => solveCaptcha("recaptcha-v3", "site-key", "https://example.com", "login", "api-key"),
      /CapSolver createTask failed: bad key/
    );
  });
});
