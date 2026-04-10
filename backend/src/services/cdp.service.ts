import WebSocket from "ws";
import { config } from "../config.js";
import { solveRecaptchaEnterprise } from "./capsolver.service.js";
import { prisma } from "../db/client.js";

// Script injected into every page before any page JavaScript runs.
// Overrides the WebAuthn JS API so websites see no passkey support,
// preventing Google's passkey challenge flow from triggering OS-level
// dialogs that can never resolve inside a headless container.
//
// Strategy: replace PublicKeyCredential with a fake class whose static
// capability-detection methods (isUserVerifyingPlatformAuthenticatorAvailable,
// isConditionalMediationAvailable) return Promise<false>. Setting the class to
// undefined instead would cause those calls to throw, leaving Google's
// /challenge/pk page stuck in its loading state rather than falling through
// to "Try another way".
const PASSKEY_OVERRIDE_SCRIPT = `
try {
  function FakePublicKeyCredential() {
    throw new DOMException('Operation not allowed', 'NotAllowedError');
  }
  FakePublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
    function() { return Promise.resolve(false); };
  FakePublicKeyCredential.isConditionalMediationAvailable =
    function() { return Promise.resolve(false); };
  FakePublicKeyCredential.getClientCapabilities =
    function() { return Promise.resolve({}); };
  Object.defineProperty(window, 'PublicKeyCredential', {
    value: FakePublicKeyCredential, writable: false, configurable: false
  });
} catch(e) {}
if (navigator.credentials) {
  try {
    const reject = () =>
      Promise.reject(new DOMException('Operation not allowed', 'NotAllowedError'));
    navigator.credentials.get = reject;
    navigator.credentials.create = reject;
  } catch(e) {}
}
`.trim();

// Script injected to hide headless-Chrome automation signals.
// Patches the most commonly fingerprinted JS properties so that
// bot-detection libraries (Arkose Labs, DataDome, etc.) see a
// normal desktop Chrome rather than a WebDriver-controlled browser.
const STEALTH_SCRIPT = `
// 1. navigator.webdriver — primary automation signal
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    enumerable: true,
    configurable: true,
  });
} catch(e) {}

// 2. window.chrome — headless Chrome lacks this object or has it empty
try {
  if (!window.chrome || !window.chrome.runtime) {
    const chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function() {},
        getIsInstalled: function() {},
        installState: function() {},
        runningState: function() {},
      },
      csi: function() {
        return { onloadT: Date.now(), pageT: Date.now(), startE: Date.now(), tran: 15 };
      },
      loadTimes: function() {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      },
      runtime: {},
    };
    Object.defineProperty(window, 'chrome', {
      value: chrome,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  }
} catch(e) {}

// 3. navigator.plugins — empty in headless, should have PDF viewer entries
try {
  if (navigator.plugins.length === 0) {
    const pluginNames = [
      'PDF Viewer',
      'Chrome PDF Viewer',
      'Chromium PDF Viewer',
      'Microsoft Edge PDF Viewer',
      'WebKit built-in PDF',
    ];
    const fakeArr = Object.create(PluginArray.prototype);
    pluginNames.forEach(function(name, i) {
      const p = Object.create(Plugin.prototype);
      Object.defineProperties(p, {
        name:        { value: name,                    enumerable: true },
        filename:    { value: 'internal-pdf-viewer',   enumerable: true },
        description: { value: 'Portable Document Format', enumerable: true },
        length:      { value: 0,                       enumerable: true },
      });
      p.item = function() { return null; };
      p.namedItem = function() { return null; };
      Object.defineProperty(fakeArr, i,    { value: p, enumerable: true });
      Object.defineProperty(fakeArr, name, { value: p, enumerable: false });
    });
    Object.defineProperty(fakeArr, 'length', { value: pluginNames.length, enumerable: true });
    fakeArr.item = function(i) { return fakeArr[i] || null; };
    fakeArr.namedItem = function(n) { return fakeArr[n] || null; };
    fakeArr.refresh = function() {};
    Object.defineProperty(navigator, 'plugins', { get: function() { return fakeArr; }, configurable: true });
  }
} catch(e) {}

// 4. navigator.mimeTypes — should match plugins
try {
  if (navigator.mimeTypes.length === 0) {
    const fakeMt = Object.create(MimeTypeArray.prototype);
    const entry = Object.create(MimeType.prototype);
    Object.defineProperties(entry, {
      type:        { value: 'application/pdf', enumerable: true },
      suffixes:    { value: 'pdf',             enumerable: true },
      description: { value: '',                enumerable: true },
    });
    Object.defineProperty(fakeMt, 0,                 { value: entry, enumerable: true });
    Object.defineProperty(fakeMt, 'application/pdf', { value: entry, enumerable: false });
    Object.defineProperty(fakeMt, 'length', { value: 1, enumerable: true });
    fakeMt.item = function(i) { return fakeMt[i] || null; };
    fakeMt.namedItem = function(n) { return fakeMt[n] || null; };
    Object.defineProperty(navigator, 'mimeTypes', { get: function() { return fakeMt; }, configurable: true });
  }
} catch(e) {}

// navigator.permissions.query — intentionally not patched.
// Returning a plain object instead of a real PermissionStatus instance
// breaks third-party scripts (e.g. reCAPTCHA) that check instanceof or
// use addEventListener on the result.
`.trim();

// Intercepts grecaptcha.enterprise.execute() calls and routes them through
// a CDP binding so the backend can obtain a high-score token via CapSolver.
// Falls back to the original execute() if the binding is unavailable (e.g.
// CAPSOLVER_API_KEY not configured).
const RECAPTCHA_INTERCEPT_SCRIPT = `
(function() {
  if (window.__browsermint_captcha_patched) return;
  window.__browsermint_captcha_patched = true;

  var pending = new Map();

  window.__browsermint_resolve_captcha = function(requestId, token) {
    var p = pending.get(requestId);
    if (p) { pending.delete(requestId); p.resolve(token); }
  };

  window.__browsermint_reject_captcha = function(requestId, err) {
    var p = pending.get(requestId);
    if (p) { pending.delete(requestId); p.reject(new Error(err)); }
  };

  function patchEnterprise(enterprise) {
    if (enterprise.__browsermint_patched) return;
    enterprise.__browsermint_patched = true;
    var orig = enterprise.execute.bind(enterprise);
    enterprise.execute = function(siteKey, options) {
      var action = (options && options.action) || '';
      var requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      return new Promise(function(resolve, reject) {
        pending.set(requestId, { resolve: resolve, reject: reject });
        try {
          window.__browsermint_solve_captcha(JSON.stringify({
            requestId: requestId,
            siteKey: siteKey,
            action: action,
            url: location.href
          }));
        } catch(e) {
          // Binding not available — fall back to original execute
          pending.delete(requestId);
          orig(siteKey, options).then(resolve, reject);
        }
      });
    };
  }

  function patchGrecaptcha(val) {
    if (!val) return;
    if (val.enterprise) {
      if (val.enterprise.execute) { patchEnterprise(val.enterprise); return; }
      var _ent = val.enterprise;
      Object.defineProperty(val, 'enterprise', {
        get: function() { return _ent; },
        set: function(ent) { _ent = ent; if (ent && ent.execute) patchEnterprise(ent); },
        configurable: true
      });
      return;
    }
    var _enterprise;
    Object.defineProperty(val, 'enterprise', {
      get: function() { return _enterprise; },
      set: function(ent) { _enterprise = ent; if (ent && ent.execute) patchEnterprise(ent); },
      configurable: true
    });
  }

  var _grecaptcha = window.grecaptcha;
  Object.defineProperty(window, 'grecaptcha', {
    get: function() { return _grecaptcha; },
    set: function(val) { _grecaptcha = val; patchGrecaptcha(val); },
    configurable: true
  });

  if (window.grecaptcha) patchGrecaptcha(window.grecaptcha);
})();
`.trim();

// One persistent browser-level CDP WebSocket per session.
const activeSessions = new Map<string, WebSocket>();
const sessionUserAgents = new Map<string, string>();

let msgIdCounter = 1;

function sendCmd(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
): number {
  const id = msgIdCounter++;
  const msg: Record<string, unknown> = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return id;
}

function waitForResponse(
  ws: WebSocket,
  id: number,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`CDP timeout waiting for response to id=${id}`));
    }, timeoutMs);

    function handler(data: WebSocket.RawData) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id === id) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    }

    ws.on("message", handler);
  });
}

async function applyScriptToPage(
  ws: WebSocket,
  targetId: string,
  existingSessionId?: string
): Promise<void> {
  let pageSessionId: string;

  if (existingSessionId) {
    pageSessionId = existingSessionId;
  } else {
    const attachId = sendCmd(ws, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const attachResp = await waitForResponse(ws, attachId);
    const result = attachResp.result as Record<string, unknown> | undefined;
    if (!result?.sessionId) {
      console.warn(`[cdp] Target.attachToTarget returned no sessionId for target ${targetId}`, attachResp.error ?? "");
      return;
    }
    pageSessionId = result.sessionId as string;
  }

  // Register CDP binding so page JS can request captcha solving from backend
  if (config.CAPSOLVER_API_KEY) {
    const bindingId = sendCmd(ws, "Runtime.addBinding", { name: "__browsermint_solve_captcha" }, pageSessionId);
    await waitForResponse(ws, bindingId);
  }

  const combinedScript = STEALTH_SCRIPT + "\n\n" + PASSKEY_OVERRIDE_SCRIPT + "\n\n" + RECAPTCHA_INTERCEPT_SCRIPT;

  // Register for all future document loads in this page
  const scriptId = sendCmd(
    ws,
    "Page.addScriptToEvaluateOnNewDocument",
    { source: combinedScript },
    pageSessionId
  );
  await waitForResponse(ws, scriptId);

  // Also apply immediately to the already-loaded document (popup or navigated page)
  const evalId = sendCmd(
    ws,
    "Runtime.evaluate",
    { expression: combinedScript, returnByValue: false },
    pageSessionId
  );
  await waitForResponse(ws, evalId);
}

// Returns true if Chrome CDP is reachable and scripts were injected.
// Returns false if Chrome is not running (crashed / not yet started).
export async function initCdpSession(
  sessionId: string,
  internalApiUrl: string
): Promise<boolean> {
  // Extract container IP from internalApiUrl (e.g. http://192.168.x.x:3000)
  const url = new URL(internalApiUrl);
  const containerIp = url.hostname;
  const cdpBase = `http://${containerIp}:9223`;

  // Port 9223 is nginx proxying Chrome CDP on 127.0.0.1:9222. Chrome may not
  // be ready immediately after the Steel Browser API (port 3000) becomes healthy,
  // so retry until the CDP version endpoint returns valid JSON.
  let browserWsUrl = "";
  {
    const CDP_RETRY_INTERVAL_MS = 2000;
    const CDP_TIMEOUT_MS = 30_000;
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    let lastErr: unknown;
    let resolved = false;

    console.info(`[cdp] Waiting for Chrome to start for session ${sessionId} (timeout: ${CDP_TIMEOUT_MS / 1000}s)...`);
    while (Date.now() < deadline) {
      try {
        const versionResp = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(3000) });
        if (!versionResp.ok) throw new Error(`HTTP ${versionResp.status}`);
        const version = (await versionResp.json()) as Record<string, string>;
        // webSocketDebuggerUrl uses port 80 (nginx internal routing); rewrite to
        // the externally-accessible nginx CDP proxy on port 9223.
        browserWsUrl = version.webSocketDebuggerUrl.replace(
          /^ws:\/\/[^/]+/,
          `ws://${containerIp}:9223`
        );
        resolved = true;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, CDP_RETRY_INTERVAL_MS));
      }
    }

    if (!resolved) {
      console.warn(`[cdp] Failed to get CDP version for session ${sessionId}:`, lastErr);
      return false;
    }
    console.info(`[cdp] Chrome CDP responding for session ${sessionId}, connecting WebSocket...`);
  }

  const ws = new WebSocket(browserWsUrl);
  activeSessions.set(sessionId, ws);

  ws.on("error", (err) => {
    console.warn(`[cdp] WebSocket error for session ${sessionId}:`, err.message);
  });

  ws.on("close", () => {
    activeSessions.delete(sessionId);
  });

  // Handle incoming events (auto-attach notifications for new pages)
  ws.on("message", async (data: WebSocket.RawData) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.method === "Runtime.bindingCalled" && config.CAPSOLVER_API_KEY) {
      const params = msg.params as Record<string, unknown> | undefined;
      const pageSessionId = msg.sessionId as string | undefined;
      if (params?.name === "__browsermint_solve_captcha" && pageSessionId) {
        let payload: { requestId: string; siteKey: string; action: string; url: string };
        try {
          payload = JSON.parse(params.payload as string);
        } catch {
          return;
        }
        const capsolverStart = Date.now();
        const userAgent = sessionUserAgents.get(sessionId);
        solveRecaptchaEnterprise(payload.siteKey, payload.url, payload.action, config.CAPSOLVER_API_KEY, userAgent)
          .then(({ token, taskId }) => {
            const expr = `window.__browsermint_resolve_captcha(${JSON.stringify(payload.requestId)},${JSON.stringify(token)})`;
            sendCmd(ws, "Runtime.evaluate", { expression: expr }, pageSessionId);
            console.log(`[cdp] CapSolver: resolved captcha for session ${sessionId}`);
            prisma.sessionEvent.create({
              data: {
                sessionId,
                operationType: "capsolver",
                sourceIp: null,
                requestPath: null,
                statusCode: 200,
                metadata: {
                  url: payload.url,
                  siteKey: payload.siteKey,
                  action: payload.action,
                  taskId,
                  tokenLength: token.length,
                  userAgent: userAgent ?? null,
                  durationMs: Date.now() - capsolverStart,
                },
                source: "system",
              },
            }).catch(() => {});
          })
          .catch((err: Error) => {
            const expr = `window.__browsermint_reject_captcha(${JSON.stringify(payload.requestId)},${JSON.stringify(err.message)})`;
            sendCmd(ws, "Runtime.evaluate", { expression: expr }, pageSessionId);
            console.warn(`[cdp] CapSolver failed for session ${sessionId}:`, err.message);
            prisma.sessionEvent.create({
              data: {
                sessionId,
                operationType: "capsolver",
                sourceIp: null,
                requestPath: null,
                statusCode: 500,
                metadata: {
                  url: payload.url,
                  siteKey: payload.siteKey,
                  action: payload.action,
                  userAgent: userAgent ?? null,
                  durationMs: Date.now() - capsolverStart,
                  error: err.message,
                },
                source: "system",
              },
            }).catch(() => {});
          });
      }
      return;
    }

    if (msg.method === "Target.attachedToTarget") {
      const params = msg.params as Record<string, unknown> | undefined;
      const autoSessionId = params?.sessionId as string | undefined;
      const info = params?.targetInfo as Record<string, unknown> | undefined;
      if (info?.type === "page" && autoSessionId) {
        try {
          // Use the session ID from the auto-attach event directly (no re-attach needed).
          // Also apply immediately via Runtime.evaluate in case the page is already loaded.
          await applyScriptToPage(ws, info.targetId as string, autoSessionId);
        } catch (err) {
          console.warn(`[cdp] Failed to apply script to new page (session ${sessionId}):`, err);
        }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP WebSocket open timeout")), 8000);
    ws.once("open", () => {
      clearTimeout(timeout);
      console.info(`[cdp] WebSocket connected for session ${sessionId}`);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  }).catch((err) => {
    console.warn(`[cdp] Failed to open browser WebSocket for session ${sessionId}:`, err.message);
    activeSessions.delete(sessionId);
  });

  // If the WebSocket failed to open, activeSessions won't have this session
  if (!activeSessions.has(sessionId)) return false;

  try {
    // Fetch the browser user-agent once per session so capsolver can use it
    // when solving reCAPTCHA Enterprise (matching UA improves token score).
    try {
      const versionId = sendCmd(ws, "Browser.getVersion", {});
      const versionResp = await waitForResponse(ws, versionId, 5000);
      const ua = (versionResp.result as Record<string, unknown>)?.userAgent as string | undefined;
      if (ua) sessionUserAgents.set(sessionId, ua);
    } catch { /* non-fatal */ }

    // Enable auto-attach so we get notified when new tabs/pages are created
    const autoAttachId = sendCmd(ws, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await waitForResponse(ws, autoAttachId);

    // Apply script to all existing page targets
    const getTargetsId = sendCmd(ws, "Target.getTargets", {});
    const targetsResp = await waitForResponse(ws, getTargetsId);
    const targets = (
      (targetsResp.result as Record<string, unknown>)?.targetInfos ?? []
    ) as Array<Record<string, unknown>>;

    for (const target of targets) {
      if (target.type === "page" && typeof target.targetId === "string") {
        await applyScriptToPage(ws, target.targetId).catch((err) => {
          console.warn(`[cdp] Failed to apply script to existing page ${target.targetId}:`, err);
        });
      }
    }

    console.log(`[cdp] Initialized stealth+passkey override for session ${sessionId} (${targets.filter(t => t.type === "page").length} page(s))`);
  } catch (err) {
    console.warn(`[cdp] CDP initialization failed for session ${sessionId}:`, err);
    // Don't rethrow — session is still usable, override is best-effort
  }
  return true;
}

// Sends Browser.close via CDP and waits for Chrome to exit cleanly.
// Returns true if Chrome closed within the timeout, false otherwise.
// A graceful close lets Chrome flush session data and remove lock files,
// preventing profile corruption on the next container start.
export async function closeBrowserGracefully(
  sessionId: string,
  timeoutMs = 8000
): Promise<boolean> {
  const ws = activeSessions.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[cdp] Browser.close timed out for session ${sessionId} after ${timeoutMs}ms`);
      resolve(false);
    }, timeoutMs);

    // Chrome closes the WebSocket connection when it exits cleanly.
    ws.once("close", () => {
      clearTimeout(timer);
      console.info(`[cdp] Browser closed gracefully for session ${sessionId}`);
      resolve(true);
    });

    sendCmd(ws, "Browser.close", {});
  });
}

// Returns the URLs of all real (http/https) pages currently open in the browser.
// Used to save tab state before stopping a session.
export async function getOpenPageUrls(sessionId: string): Promise<string[]> {
  const ws = activeSessions.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return [];

  try {
    const getTargetsId = sendCmd(ws, "Target.getTargets", {});
    const targetsResp = await waitForResponse(ws, getTargetsId, 5000);
    const targets = (
      (targetsResp.result as Record<string, unknown>)?.targetInfos ?? []
    ) as Array<Record<string, unknown>>;

    return targets
      .filter(t => t.type === "page")
      .map(t => t.url as string)
      .filter(url => url.startsWith("http://") || url.startsWith("https://"));
  } catch (err) {
    console.warn(`[cdp] Failed to get open page URLs for session ${sessionId}:`, err);
    return [];
  }
}

// Opens a list of saved URLs after a session resumes.
// Reuses the initial blank "New Tab" page for the first URL to avoid leaving
// a stray empty tab; remaining URLs are opened as new targets.
export async function openSavedTabs(sessionId: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const ws = activeSessions.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const getTargetsId = sendCmd(ws, "Target.getTargets", {});
    const targetsResp = await waitForResponse(ws, getTargetsId, 5000);
    const targets = (
      (targetsResp.result as Record<string, unknown>)?.targetInfos ?? []
    ) as Array<Record<string, unknown>>;

    // Find the initial blank/newtab page Chrome opens on startup
    const blankTarget = targets.find(
      t => t.type === "page" &&
        ((t.url as string) === "about:blank" || (t.url as string).startsWith("chrome://newtab"))
    );

    const [firstUrl, ...restUrls] = urls;

    if (blankTarget) {
      // Navigate the existing blank tab to the first URL instead of creating a new one
      const attachId = sendCmd(ws, "Target.attachToTarget", {
        targetId: blankTarget.targetId as string,
        flatten: true,
      });
      const attachResp = await waitForResponse(ws, attachId, 5000);
      const pageSessionId = (
        (attachResp.result as Record<string, unknown>)?.sessionId
      ) as string | undefined;

      if (pageSessionId) {
        sendCmd(ws, "Page.navigate", { url: firstUrl }, pageSessionId);
      } else {
        sendCmd(ws, "Target.createTarget", { url: firstUrl });
      }
    } else {
      sendCmd(ws, "Target.createTarget", { url: firstUrl });
    }

    for (const url of restUrls) {
      sendCmd(ws, "Target.createTarget", { url });
    }

    console.info(`[cdp] Restoring ${urls.length} tab(s) for session ${sessionId}`);
  } catch (err) {
    console.warn(`[cdp] Failed to restore tabs for session ${sessionId}:`, err);
  }
}

export function cleanupCdpSession(sessionId: string): void {
  const ws = activeSessions.get(sessionId);
  if (ws) {
    ws.terminate();
    activeSessions.delete(sessionId);
  }
  sessionUserAgents.delete(sessionId);
}

export async function executeCdpCommand(
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
  targetId?: string
): Promise<Record<string, unknown>> {
  const ws = activeSessions.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error(`No active CDP session for session ${sessionId}`);
  }

  let pageSessionId: string | undefined;
  if (targetId) {
    const attachId = sendCmd(ws, "Target.attachToTarget", { targetId, flatten: true });
    const attachResp = await waitForResponse(ws, attachId);
    const res = attachResp.result as Record<string, unknown> | undefined;
    if (!res?.sessionId) throw new Error(`Failed to attach to target ${targetId}`);
    pageSessionId = res.sessionId as string;
  }

  const cmdId = sendCmd(ws, method, params, pageSessionId);
  const resp = await waitForResponse(ws, cmdId, 8000);
  if (resp.error) throw new Error(JSON.stringify(resp.error));
  return (resp.result ?? {}) as Record<string, unknown>;
}
