import WebSocket from "ws";
import { config } from "../config.js";
import { solveRecaptchaEnterprise } from "./capsolver.service.js";

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
  if (window.__steelyard_captcha_patched) return;
  window.__steelyard_captcha_patched = true;

  var pending = new Map();

  window.__steelyard_resolve_captcha = function(requestId, token) {
    var p = pending.get(requestId);
    if (p) { pending.delete(requestId); p.resolve(token); }
  };

  window.__steelyard_reject_captcha = function(requestId, err) {
    var p = pending.get(requestId);
    if (p) { pending.delete(requestId); p.reject(new Error(err)); }
  };

  function patchEnterprise(enterprise) {
    if (enterprise.__steelyard_patched) return;
    enterprise.__steelyard_patched = true;
    var orig = enterprise.execute.bind(enterprise);
    enterprise.execute = function(siteKey, options) {
      var action = (options && options.action) || '';
      var requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      return new Promise(function(resolve, reject) {
        pending.set(requestId, { resolve: resolve, reject: reject });
        try {
          window.__steelyard_solve_captcha(JSON.stringify({
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
    const bindingId = sendCmd(ws, "Runtime.addBinding", { name: "__steelyard_solve_captcha" }, pageSessionId);
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

export async function initCdpSession(
  sessionId: string,
  internalApiUrl: string
): Promise<void> {
  // Extract container IP from internalApiUrl (e.g. http://192.168.x.x:3000)
  const url = new URL(internalApiUrl);
  const containerIp = url.hostname;
  const cdpBase = `http://${containerIp}:9223`;

  // Port 9223 is nginx proxying Chrome CDP on 127.0.0.1:9222. Chrome may not
  // be ready immediately after the Steel Browser API (port 3000) becomes healthy,
  // so retry until the CDP version endpoint returns valid JSON.
  let browserWsUrl: string;
  {
    const CDP_RETRY_INTERVAL_MS = 2000;
    const CDP_TIMEOUT_MS = 30_000;
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    let lastErr: unknown;
    let resolved = false;

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
      return;
    }
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
      if (params?.name === "__steelyard_solve_captcha" && pageSessionId) {
        let payload: { requestId: string; siteKey: string; action: string; url: string };
        try {
          payload = JSON.parse(params.payload as string);
        } catch {
          return;
        }
        solveRecaptchaEnterprise(payload.siteKey, payload.url, payload.action, config.CAPSOLVER_API_KEY)
          .then((token) => {
            const expr = `window.__steelyard_resolve_captcha(${JSON.stringify(payload.requestId)},${JSON.stringify(token)})`;
            sendCmd(ws, "Runtime.evaluate", { expression: expr }, pageSessionId);
            console.log(`[cdp] CapSolver: resolved captcha for session ${sessionId}`);
          })
          .catch((err: Error) => {
            const expr = `window.__steelyard_reject_captcha(${JSON.stringify(payload.requestId)},${JSON.stringify(err.message)})`;
            sendCmd(ws, "Runtime.evaluate", { expression: expr }, pageSessionId);
            console.warn(`[cdp] CapSolver failed for session ${sessionId}:`, err.message);
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
  if (!activeSessions.has(sessionId)) return;

  try {
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
}

export function cleanupCdpSession(sessionId: string): void {
  const ws = activeSessions.get(sessionId);
  if (ws) {
    ws.terminate();
    activeSessions.delete(sessionId);
  }
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
