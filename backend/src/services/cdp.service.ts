import WebSocket from "ws";
import { config } from "../config.js";
import { holdsLease, forgetTargetLeases } from "./lease.service.js";
import { BROWSER_DEVICE_SCALE_FACTOR } from "./driver/session-driver.js";
import { solveCaptcha, type CaptchaType } from "./capsolver.service.js";
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
// 1. navigator.webdriver — DO NOT patch this property on the navigator instance.
// --disable-blink-features=AutomationControlled already makes navigator.webdriver
// return undefined at the C++ level, which matches a real non-automated browser.
// Adding an Object.defineProperty override here would create a detectable own
// property on the navigator instance (hasOwnProperty, getOwnPropertyDescriptor)
// and return false instead of undefined — both are fingerprinted by X and others.

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

// hardwareConcurrency, deviceMemory, WebGL vendor/renderer — NOT patched here.
// Steel Browser's FingerprintGenerator already injects consistent, realistic
// random values for all three via loadFingerprintScript/injectFingerprintSafely.
// Adding our own fixed overrides on top would create fingerprint inconsistencies
// (e.g. fixed concurrency=8 mismatching a generated screen resolution that implies
// different hardware) and would stomp Steel's carefully correlated values.

// 5. Canvas 2D fingerprint noise
// --use-angle=swiftshader produces deterministic pixel output for any given set of
// drawing operations — the resulting canvas hash is constant across all sessions and
// is listed in Castle.io / fingerprinting databases as an automation signal.
//
// Root cause of naive patch failing: canvas internals use premultiplied alpha.
// Writing a pixel with alpha=0 via putImageData causes the browser to store
// RGB=(0,0,0) regardless of the values set, so toDataURL sees no change.
//
// Fix:
// • toDataURL — copy canvas to an offscreen element, draw a 1×1 near-black opaque
//   noise pixel at (0,0) on the copy (full alpha guarantees it survives premultiply),
//   then serialise the copy. The original canvas is never touched.
// • getImageData — skip transparent pixels; XOR the red channel of the first
//   opaque pixel in the returned copy only (canvas itself unchanged).
try {
  const _cs = (Math.random() * 0xFE | 0) + 1; // 1–255 per-session seed
  const _origGID = CanvasRenderingContext2D.prototype.getImageData;
  const _origTDU = HTMLCanvasElement.prototype.toDataURL;
  let _noiseBusy = false;

  // getImageData: modify the returned copy, not the canvas.
  CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
    const img = _origGID.call(this, x, y, w, h);
    if (!_noiseBusy && img.data.length >= 4) {
      const limit = Math.min(img.data.length, 1024); // search up to 256 pixels
      for (let i = 0; i < limit; i += 4) {
        if (img.data[i + 3] > 0) { img.data[i] = img.data[i] ^ _cs; break; }
      }
    }
    return img;
  };

  // toDataURL: draw canvas onto an offscreen copy, stamp a 1×1 noise pixel at
  // (0,0) with full alpha, serialise the copy. Original canvas is untouched.
  // Max colour is rgb(32,8,0) — visually imperceptible at the canvas corner.
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    if (_noiseBusy || this.width === 0 || this.height === 0) {
      return _origTDU.call(this, type, quality);
    }
    _noiseBusy = true;
    try {
      const oc = document.createElement('canvas');
      oc.width = this.width; oc.height = this.height;
      const octx = oc.getContext('2d');
      if (!octx) return _origTDU.call(this, type, quality);
      octx.drawImage(this, 0, 0);
      octx.fillStyle = 'rgb(' + ((_cs & 0x1F) + 1) + ',' + (((_cs >> 5) & 0x07) + 1) + ',0)';
      octx.globalAlpha = 1;
      octx.globalCompositeOperation = 'source-over';
      octx.fillRect(0, 0, 1, 1);
      return _origTDU.call(oc, type, quality);
    } finally {
      _noiseBusy = false;
    }
  };
} catch(e) {}
`.trim();

// Intercepts JS captcha APIs and routes them through a CDP binding so the
// backend can obtain tokens via CapSolver. Covers:
//   - reCAPTCHA Enterprise  (grecaptcha.enterprise.execute)
//   - reCAPTCHA v3          (grecaptcha.execute with string siteKey)
//   - Cloudflare Turnstile  (turnstile.render / turnstile.execute)
//   - hCaptcha              (hcaptcha.execute with string siteKey)
// Falls back to the original API if the CDP binding is unavailable.
const CAPTCHA_INTERCEPT_SCRIPT = `
(function() {
  // Guard stored as a non-enumerable property so it does not appear in
  // window property scans (Object.keys, for-in, getOwnPropertyNames).
  if (Object.getOwnPropertyDescriptor(window, '__browsermint_captcha_patched')) return;
  Object.defineProperty(window, '__browsermint_captcha_patched', {
    value: true, enumerable: false, configurable: false, writable: false,
  });

  var pending = new Map();

  // Non-enumerable so property scans (used by bot-detection scripts) don't
  // find our callback names on window.
  Object.defineProperty(window, '__browsermint_resolve_captcha', {
    value: function(requestId, token) {
      var p = pending.get(requestId);
      if (p) { pending.delete(requestId); p.resolve(token); }
    },
    enumerable: false, configurable: true, writable: false,
  });

  Object.defineProperty(window, '__browsermint_reject_captcha', {
    value: function(requestId, err) {
      var p = pending.get(requestId);
      if (p) { pending.delete(requestId); p.reject(new Error(err)); }
    },
    enumerable: false, configurable: true, writable: false,
  });

  function makeId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // Send payload to backend; call onFallback if the CDP binding is not registered.
  function sendRequest(payload, onToken, onFallback) {
    var requestId = makeId();
    payload.requestId = requestId;
    pending.set(requestId, { resolve: onToken, reject: onFallback });
    try {
      window.__browsermint_solve_captcha(JSON.stringify(payload));
    } catch(e) {
      pending.delete(requestId);
      onFallback(new Error('binding unavailable'));
    }
  }

  // ── reCAPTCHA Enterprise ──────────────────────────────────────────────────
  function patchEnterprise(enterprise) {
    if (enterprise.__browsermint_patched) return;
    enterprise.__browsermint_patched = true;
    var orig = enterprise.execute.bind(enterprise);
    enterprise.execute = function(siteKey, options) {
      var action = (options && options.action) || '';
      return new Promise(function(resolve, reject) {
        sendRequest(
          { type: 'recaptcha-enterprise', siteKey: siteKey, action: action, url: location.href },
          resolve,
          function() { orig(siteKey, options).then(resolve, reject); }
        );
      });
    };
  }

  // ── reCAPTCHA v2 ─────────────────────────────────────────────────────────
  // grecaptcha.render(container, {sitekey, callback, size, ...}) — intercept
  // to capture siteKey and solve immediately (explicit mode) or on execute()
  // (invisible mode). Token is injected into g-recaptcha-response and the
  // page callback is called directly without rendering the iframe.
  var v2Widgets = new Map(); // widgetId (int) -> { siteKey, callback, container }
  var v2WidgetCounter = 0;

  function injectV2Token(container, token) {
    // reCAPTCHA Enterprise creates the response textarea at the document level,
    // outside the .g-recaptcha container. Prefer that over creating a new one
    // inside the container, which the form serializer would not find correctly.
    var ta = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (!ta) {
      var el = (typeof container === 'string') ? document.querySelector(container) : container;
      if (el) ta = el.querySelector('textarea[name="g-recaptcha-response"]');
    }
    if (!ta) {
      var el = (typeof container === 'string') ? document.querySelector(container) : container;
      ta = document.createElement('textarea');
      ta.name = 'g-recaptcha-response';
      ta.style.display = 'none';
      (el || document.body).appendChild(ta);
    }
    ta.value = token;
  }

  function patchV2Render(grecaptchaObj) {
    if (grecaptchaObj.__browsermint_v2_patched || !grecaptchaObj.render) return;
    grecaptchaObj.__browsermint_v2_patched = true;
    var origRender = grecaptchaObj.render.bind(grecaptchaObj);
    grecaptchaObj.render = function(container, params) {
      if (!params || !params.sitekey) return origRender.apply(this, arguments);
      var siteKey = params.sitekey;
      var userCallback = params.callback;
      var widgetId = v2WidgetCounter++;
      v2Widgets.set(widgetId, { siteKey: siteKey, callback: userCallback, container: container });
      // Invisible v2: defer solving until execute(widgetId) is called
      if (params.size === 'invisible') return widgetId;
      // Explicit v2: solve immediately; skip rendering the iframe
      sendRequest(
        { type: 'recaptcha-v2', siteKey: siteKey, url: location.href },
        function(token) {
          injectV2Token(container, token);
          if (userCallback) userCallback(token);
          // form.submit() may not trigger navigation in headless; click the submit button too
          var el2 = (typeof container === 'string') ? document.querySelector(container) : container;
          var form2 = el2 ? el2.closest('form') : document.querySelector('form');
          if (form2) { var btn2 = form2.querySelector('input[type=submit],button[type=submit],button'); if (btn2) btn2.click(); }
        },
        function() { origRender.call(grecaptchaObj, container, params); }
      );
      return widgetId;
    };
  }

  // Handles both v3 (string siteKey) and v2 invisible (numeric widgetId).
  function patchExecute(grecaptchaObj) {
    if (grecaptchaObj.__browsermint_execute_patched || !grecaptchaObj.execute) return;
    grecaptchaObj.__browsermint_execute_patched = true;
    var orig = grecaptchaObj.execute.bind(grecaptchaObj);
    grecaptchaObj.execute = function(siteKeyOrWidgetId, options) {
      if (typeof siteKeyOrWidgetId === 'string') {
        // reCAPTCHA v3 non-enterprise
        var action = (options && options.action) || '';
        return new Promise(function(resolve, reject) {
          sendRequest(
            { type: 'recaptcha-v3', siteKey: siteKeyOrWidgetId, action: action, url: location.href },
            resolve,
            function() { orig(siteKeyOrWidgetId, options).then(resolve, reject); }
          );
        });
      }
      // Numeric widgetId — invisible v2
      var info = v2Widgets.get(siteKeyOrWidgetId);
      if (!info) return orig.apply(this, arguments);
      sendRequest(
        { type: 'recaptcha-v2', siteKey: info.siteKey, url: location.href },
        function(token) {
          injectV2Token(info.container, token);
          if (info.callback) info.callback(token);
        },
        function() { orig.call(grecaptchaObj, siteKeyOrWidgetId, options); }
      );
    };
  }

  function patchGrecaptcha(val) {
    if (!val) return;
    // Enterprise — patch execute and render immediately if available, and watch for late assignment
    if (val.enterprise) {
      if (val.enterprise.execute) patchEnterprise(val.enterprise);
      patchV2Render(val.enterprise);
    }
    var _enterprise = val.enterprise;
    Object.defineProperty(val, 'enterprise', {
      get: function() { return _enterprise; },
      set: function(ent) {
        _enterprise = ent;
        if (ent) {
          if (ent.execute) patchEnterprise(ent);
          patchV2Render(ent);
        }
      },
      configurable: true
    });
    // v2: intercept render()
    patchV2Render(val);
    // v3 non-enterprise + v2 invisible: intercept execute()
    patchExecute(val);
  }

  var _grecaptcha = window.grecaptcha;
  Object.defineProperty(window, 'grecaptcha', {
    get: function() { return _grecaptcha; },
    set: function(val) { _grecaptcha = val; patchGrecaptcha(val); },
    configurable: true
  });
  if (window.grecaptcha) patchGrecaptcha(window.grecaptcha);

  // ── Cloudflare Turnstile ──────────────────────────────────────────────────
  function patchTurnstile(t) {
    if (t.__browsermint_patched) return;
    t.__browsermint_patched = true;

    // turnstile.render(container, {sitekey, callback, ...})
    if (t.render) {
      var origRender = t.render.bind(t);
      t.render = function(container, params) {
        if (!params || !params.sitekey) return origRender.apply(this, arguments);
        var userCallback = params.callback;
        var origArgs = arguments;
        sendRequest(
          { type: 'turnstile', siteKey: params.sitekey, url: location.href },
          function(token) { if (userCallback) userCallback(token); },
          function() { origRender.apply(t, origArgs); }
        );
        return '__browsermint_widget';
      };
    }

    // turnstile.execute(container, params) — invisible mode
    if (t.execute) {
      var origExecute = t.execute.bind(t);
      t.execute = function(container, params) {
        var p = (typeof container === 'object' && container && container.sitekey) ? container : params;
        if (!p || !p.sitekey) return origExecute.apply(this, arguments);
        var userCallback = p.callback;
        var origArgs = arguments;
        sendRequest(
          { type: 'turnstile', siteKey: p.sitekey, url: location.href },
          function(token) { if (userCallback) userCallback(token); },
          function() { origExecute.apply(t, origArgs); }
        );
      };
    }
  }

  // NOTE: window.turnstile is intentionally NOT pre-defined via Object.defineProperty.
  // Cloudflare's api.js checks whether 'turnstile' is already a key on window (via
  // "in" operator or Object.hasOwn) and bails out early if it is, printing "Turnstile
  // already has been loaded". Pre-defining the property causes Cloudflare to skip
  // initialisation entirely, leaving window.turnstile = undefined permanently.
  // The polling loop below catches the assignment after Cloudflare initialises.

  // ── hCaptcha ──────────────────────────────────────────────────────────────
  // hcaptcha.execute(siteKey, options) — invisible / programmatic mode.
  // hcaptcha.execute(widgetId)         — widget-ID form (numeric); skip.
  function patchHCaptcha(h) {
    if (h.__browsermint_patched) return;
    h.__browsermint_patched = true;
    if (!h.execute) return;
    var orig = h.execute.bind(h);
    h.execute = function(siteKeyOrWidgetId, options) {
      if (typeof siteKeyOrWidgetId !== 'string') return orig.apply(this, arguments);
      return new Promise(function(resolve, reject) {
        sendRequest(
          { type: 'hcaptcha', siteKey: siteKeyOrWidgetId, url: location.href },
          resolve,
          function(err) { reject(err); }
        );
      });
    };
  }

  // NOTE: window.hcaptcha is also NOT pre-defined, for the same reason as turnstile.

  // Polling fallback: reCAPTCHA often sets window.grecaptcha = {} first and then
  // assigns execute/render directly on the object, so the property setter fires
  // before the methods exist. Also catches Turnstile / hCaptcha whose scripts skip
  // initialisation if they find the window property already defined.
  // Poll every 100ms for up to 20 seconds.
  var _pollCount = 0;
  var _pollId = setInterval(function() {
    if (++_pollCount > 200) { clearInterval(_pollId); return; }
    var g = window.grecaptcha;
    if (g) {
      if (g.execute && !g.__browsermint_execute_patched) { patchV2Render(g); patchExecute(g); }
      if (g.render && !g.__browsermint_v2_patched) patchV2Render(g);
      if (g.enterprise) {
        if (g.enterprise.execute && !g.enterprise.__browsermint_patched) patchEnterprise(g.enterprise);
        if (g.enterprise.render && !g.enterprise.__browsermint_v2_patched) patchV2Render(g.enterprise);
      }
      // Retroactive v2: solve .g-recaptcha elements that were rendered before our patch
      // arrived (render() was called by the page before patchV2Render ran).
      if (g.__browsermint_v2_patched || (g.enterprise && g.enterprise.__browsermint_v2_patched)) {
        var els = document.querySelectorAll('.g-recaptcha:not([data-bm-solving])');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          // Check doc-level textarea first (where enterprise.js puts it), then container
          var ta = document.querySelector('textarea[name="g-recaptcha-response"]')
                || el.querySelector('textarea[name="g-recaptcha-response"]');
          if (ta && ta.value) continue; // already solved
          var sk = el.getAttribute('data-sitekey');
          if (!sk) continue;
          el.setAttribute('data-bm-solving', '1');
          // Use enterprise type when the page loaded enterprise.js (g.enterprise patched)
          var retroType = (g.enterprise && g.enterprise.__browsermint_v2_patched) ? 'recaptcha-v2-enterprise' : 'recaptcha-v2';
          // Extract the 's' one-time token from the already-rendered anchor iframe
          var anchorS = '';
          try {
            var anchorIf = document.querySelector('iframe[src*="recaptcha/enterprise/anchor"]');
            if (anchorIf) anchorS = new URL(anchorIf.src).searchParams.get('s') || '';
          } catch(e2) {}
          (function(container, siteKey, captchaType, enterpriseS) {
            var reqPayload = { type: captchaType, siteKey: siteKey, url: location.href };
            if (enterpriseS) reqPayload.enterprisePayload = { s: enterpriseS };
            sendRequest(
              reqPayload,
              function(token) {
                injectV2Token(container, token);
                var cbName = container.getAttribute('data-callback');
                if (cbName && window[cbName]) window[cbName](token);
                // form.submit() may not trigger navigation in headless; click the submit button too
                var form3 = container.closest('form') || document.querySelector('form');
                if (form3) { var btn3 = form3.querySelector('input[type=submit],button[type=submit],button'); if (btn3) btn3.click(); }
              },
              function() { container.removeAttribute('data-bm-solving'); }
            );
          })(el, sk, retroType, anchorS);
        }
      }
    }
    if (window.turnstile && !window.turnstile.__browsermint_patched) patchTurnstile(window.turnstile);
    if (window.hcaptcha && !window.hcaptcha.__browsermint_patched) patchHCaptcha(window.hcaptcha);
  }, 100);
})();
`.trim();

// Combined script injected into every page — extracted here so both
// applyScriptToPage (initial injection) and the frameNavigated handler
// (re-injection after agent-triggered navigation) can share the same source.
// Exported so the CDP proxy bridge can inject the same script into
// agent-created page sessions (which have a separate CDP session scope).
export const COMBINED_INJECT_SCRIPT = STEALTH_SCRIPT + "\n\n" + PASSKEY_OVERRIDE_SCRIPT + "\n\n" + CAPTCHA_INTERCEPT_SCRIPT;

// One persistent browser-level CDP WebSocket per session.
const activeSessions = new Map<string, WebSocket>();
const sessionUserAgents = new Map<string, string>();

type CdpServiceOverrides = Partial<{
  initCdpSession: (sessionId: string, internalApiUrl: string) => Promise<boolean>;
  closeBrowserGracefully: (sessionId: string, timeoutMs?: number) => Promise<boolean>;
  getOpenPageUrls: (sessionId: string) => Promise<string[]>;
  getOpenPageEntries: (sessionId: string) => Promise<Array<{ targetId: string; url: string }>>;
  openSavedTabs: (sessionId: string, urls: string[]) => Promise<void>;
  restoreSavedTabs: (sessionId: string, tabs: SavedTab[]) => Promise<Record<string, string>>;
  cleanupCdpSession: (sessionId: string) => void;
  executeCdpCommand: (
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
    targetId?: string
  ) => Promise<Record<string, unknown>>;
  setTargetViewport: (
    sessionId: string,
    targetId: string,
    width: number,
    height: number,
    deviceScaleFactor?: number,
    zoom?: number
  ) => Promise<void>;
  attachCastViewer: (
    sessionId: string, targetId: string, viewer: WebSocket, leaseId?: string
  ) => Promise<void>;
}>;

let cdpServiceOverrides: CdpServiceOverrides = {};

export function setCdpServiceOverridesForTests(overrides: CdpServiceOverrides): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setCdpServiceOverridesForTests can only be used when NODE_ENV=test");
  }
  cdpServiceOverrides = overrides;
}

export function resetCdpServiceOverridesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetCdpServiceOverridesForTests can only be used when NODE_ENV=test");
  }
  cdpServiceOverrides = {};
}

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

  // Register CDP binding so page JS can request captcha solving from backend.
  // Immediately after registering, make it non-enumerable so property scans
  // (used by bot-detection scripts) do not surface it on window.
  if (config.CAPSOLVER_API_KEY) {
    const bindingId = sendCmd(ws, "Runtime.addBinding", { name: "__browsermint_solve_captcha" }, pageSessionId);
    await waitForResponse(ws, bindingId);
    sendCmd(ws, "Runtime.evaluate", {
      expression: `Object.defineProperty(window, '__browsermint_solve_captcha', { enumerable: false });`,
      returnByValue: false,
    }, pageSessionId);
  }

  // Enable Page domain events so we receive Page.frameNavigated notifications.
  // These are used to re-inject the captcha script after agent-triggered navigations
  // (addScriptToEvaluateOnNewDocument is session-scoped and only fires for navigations
  // originating from the same CDP session, so re-injection via frameNavigated is needed).
  const enableId = sendCmd(ws, "Page.enable", {}, pageSessionId);
  await waitForResponse(ws, enableId);

  // Register for all future document loads in this page
  const scriptId = sendCmd(
    ws,
    "Page.addScriptToEvaluateOnNewDocument",
    { source: COMBINED_INJECT_SCRIPT },
    pageSessionId
  );
  await waitForResponse(ws, scriptId);

  // Also apply immediately to the already-loaded document (popup or navigated page)
  const evalId = sendCmd(
    ws,
    "Runtime.evaluate",
    { expression: COMBINED_INJECT_SCRIPT, returnByValue: false },
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
  if (cdpServiceOverrides.initCdpSession) {
    return cdpServiceOverrides.initCdpSession(sessionId, internalApiUrl);
  }
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
    // Configurable: Chrome cold-starts in ~40-50s on CPU-only (swiftshader)
    // Kubernetes nodes, well past the old hard-coded 30s.
    const CDP_TIMEOUT_MS = config.CDP_INIT_TIMEOUT_MS;
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

  // Page-level viewport sockets are built from the same host (see setTargetViewport).
  sessionCdpBases.set(sessionId, browserWsUrl.replace(/\/devtools\/browser\/.*$/, ""));

  const ws = new WebSocket(browserWsUrl);
  activeSessions.set(sessionId, ws);

  ws.on("error", (err) => {
    console.warn(`[cdp] WebSocket error for session ${sessionId}:`, err.message);
  });

  ws.on("close", () => {
    activeSessions.delete(sessionId);
    // Flat session ids die with the connection; drop them so the next viewport
    // call re-attaches instead of talking to a session that no longer exists.
    forgetTargetViewport(sessionId);
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
        let payload: { requestId: string; type?: string; siteKey: string; action?: string; url: string; enterprisePayload?: Record<string, string> };
        try {
          payload = JSON.parse(params.payload as string);
        } catch {
          return;
        }
        const captchaType = (payload.type ?? "recaptcha-enterprise") as CaptchaType;
        const capsolverStart = Date.now();
        const userAgent = sessionUserAgents.get(sessionId);
        solveCaptcha(captchaType, payload.siteKey, payload.url, payload.action ?? "", config.CAPSOLVER_API_KEY, userAgent, payload.enterprisePayload)
          .then(({ token, taskId }) => {
            const expr = `window.__browsermint_resolve_captcha(${JSON.stringify(payload.requestId)},${JSON.stringify(token)})`;
            sendCmd(ws, "Runtime.evaluate", { expression: expr }, pageSessionId);
            console.log(`[cdp] CapSolver: resolved ${captchaType} for session ${sessionId}`);
            prisma.sessionEvent.create({
              data: {
                sessionId,
                operationType: "capsolver",
                sourceIp: null,
                requestPath: null,
                statusCode: 200,
                metadata: {
                  type: captchaType,
                  url: payload.url,
                  siteKey: payload.siteKey,
                  action: payload.action ?? null,
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
            console.warn(`[cdp] CapSolver failed (${captchaType}) for session ${sessionId}:`, err.message);
            prisma.sessionEvent.create({
              data: {
                sessionId,
                operationType: "capsolver",
                sourceIp: null,
                requestPath: null,
                statusCode: 500,
                metadata: {
                  type: captchaType,
                  url: payload.url,
                  siteKey: payload.siteKey,
                  action: payload.action ?? null,
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
        // A page opened from another page carries its origin here. This is the
        // only moment we learn about a tab the user opened by clicking a link:
        // the platform's page ledger is fed by explicit declares, and nobody
        // declares a tab that Chrome created on its own.
        const opener = info.openerId as string | undefined;
        if (opener) {
          notifyChildTarget(sessionId, opener, {
            targetId: info.targetId as string,
            url: info.url as string | undefined,
          });
        }
        try {
          // Use the session ID from the auto-attach event directly (no re-attach needed).
          // Also apply immediately via Runtime.evaluate in case the page is already loaded.
          await applyScriptToPage(ws, info.targetId as string, autoSessionId);
        } catch (err) {
          console.warn(`[cdp] Failed to apply script to new page (session ${sessionId}):`, err);
        }
      }
      return;
    }

    // Re-inject the captcha/stealth scripts after any main-frame navigation.
    // Page.addScriptToEvaluateOnNewDocument is session-scoped in Chrome CDP:
    // scripts registered by our backend CDP session do NOT fire when the agent's
    // separate CDP session triggers a navigation. Listening for Page.frameNavigated
    // (which is broadcast to all sessions with Page domain enabled) and re-evaluating
    // the script covers agent-triggered navigations that addScriptToEvaluateOnNewDocument
    // would otherwise miss.
    if (msg.method === "Page.frameNavigated") {
      const params = msg.params as Record<string, unknown> | undefined;
      const frame = params?.frame as Record<string, unknown> | undefined;
      const pageSessionId = msg.sessionId as string | undefined;
      // parentId absent means this is the main frame (not a sub-frame / iframe)
      if (!frame?.parentId && pageSessionId) {
        if (config.CAPSOLVER_API_KEY) {
          sendCmd(ws, "Runtime.addBinding", { name: "__browsermint_solve_captcha" }, pageSessionId);
          sendCmd(ws, "Runtime.evaluate", {
            expression: `Object.defineProperty(window, '__browsermint_solve_captcha', { enumerable: false });`,
            returnByValue: false,
          }, pageSessionId);
        }
        sendCmd(ws, "Runtime.evaluate", { expression: COMBINED_INJECT_SCRIPT, returnByValue: false }, pageSessionId);
      }
      return;
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
  if (cdpServiceOverrides.closeBrowserGracefully) {
    return cdpServiceOverrides.closeBrowserGracefully(sessionId, timeoutMs);
  }
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
/** A page as persisted across a pause: the embedder's stable label plus its URL. */
export type SavedTab = { label?: string; url: string };

/**
 * Open pages with their current CDP target ids, so callers can pair them with
 * the labels they assigned (see `Session.targetLabels`). Kept separate from
 * `getOpenPageUrls` to preserve that function's legacy shape.
 */
export async function getOpenPageEntries(
  sessionId: string
): Promise<Array<{ targetId: string; url: string }>> {
  if (cdpServiceOverrides.getOpenPageEntries) {
    return cdpServiceOverrides.getOpenPageEntries(sessionId);
  }
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
      .map(t => ({ targetId: t.targetId as string, url: t.url as string }))
      .filter(t => t.url.startsWith("http://") || t.url.startsWith("https://"));
  } catch (err) {
    console.warn(`[cdp] Failed to get open page entries for session ${sessionId}:`, err);
    return [];
  }
}

/**
 * Restore saved tabs and report which target now serves each label, so the
 * embedder can rebind its own page ids after a pause destroyed the old targets.
 */
export async function restoreSavedTabs(
  sessionId: string, tabs: SavedTab[]
): Promise<Record<string, string>> {
  if (cdpServiceOverrides.restoreSavedTabs) {
    return cdpServiceOverrides.restoreSavedTabs(sessionId, tabs);
  }
  const labels: Record<string, string> = {};
  if (!tabs.length) return labels;
  const ws = activeSessions.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return labels;

  try {
    const getTargetsId = sendCmd(ws, "Target.getTargets", {});
    const targetsResp = await waitForResponse(ws, getTargetsId, 5000);
    const targets = (
      (targetsResp.result as Record<string, unknown>)?.targetInfos ?? []
    ) as Array<Record<string, unknown>>;
    const blankTarget = targets.find(
      t => t.type === "page" &&
        ((t.url as string) === "about:blank" || (t.url as string).startsWith("chrome://newtab"))
    );

    for (const [i, tab] of tabs.entries()) {
      let targetId: string | undefined;
      if (i === 0 && blankTarget) {
        // Reuse the blank startup tab for the first page (no stray empty tab),
        // and navigate it synchronously so we can report its target id.
        targetId = blankTarget.targetId as string;
        const attachId = sendCmd(ws, "Target.attachToTarget", { targetId, flatten: true });
        const attachResp = await waitForResponse(ws, attachId, 5000);
        const pageSessionId = (
          (attachResp.result as Record<string, unknown>)?.sessionId
        ) as string | undefined;
        if (pageSessionId) {
          sendCmd(ws, "Page.navigate", { url: tab.url }, pageSessionId);
        } else {
          targetId = undefined;
        }
      }
      if (!targetId) {
        const createId = sendCmd(ws, "Target.createTarget", { url: tab.url });
        const createResp = await waitForResponse(ws, createId, 10000);
        targetId = (createResp.result as Record<string, unknown>)?.targetId as string | undefined;
      }
      if (targetId && tab.label) labels[tab.label] = targetId;
    }
    console.info(`[cdp] Restored ${tabs.length} tab(s) for session ${sessionId}`);
  } catch (err) {
    console.warn(`[cdp] Failed to restore tabs for session ${sessionId}:`, err);
  }
  return labels;
}

export async function getOpenPageUrls(sessionId: string): Promise<string[]> {
  if (cdpServiceOverrides.getOpenPageUrls) {
    return cdpServiceOverrides.getOpenPageUrls(sessionId);
  }
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
  if (cdpServiceOverrides.openSavedTabs) {
    return cdpServiceOverrides.openSavedTabs(sessionId, urls);
  }
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

// ── Per-target viewport (persistent page-level devtools sockets) ───────────
// Two facts, both established by experiment, shape this:
//  1. Emulation overrides are owned by the CDP session that set them — Chrome
//     drops them the moment that session goes away. So a fire-and-forget attach
//     (what executeCdpCommand does) can never hold a viewport.
//  2. A *flat* session (Target.attachToTarget) does not relayout the page:
//     after setting 735px through one, the page still reported innerWidth 1920.
//     A **page-level** socket (/devtools/page/<targetId>) does: innerWidth
//     becomes 735 and `max-width` media queries flip. That is the one that makes
//     the page actually reflow, so this is what we hold open per target.
const targetViewportSockets = new Map<string, WebSocket>();          // `${sessionId}:${targetId}`
// width/height 是**栏**的 CSS 尺寸；zoom 是用户选的缩放（1 = 100%）。布局视口 =
// 栏宽 / zoom：缩小(zoom<1) → 布局更宽 → 内容显小但帧像素更多（HiDPI 上更锐利），
// 与浏览器 Ctrl +/− 的语义一致。
type ViewportWant = { width: number; height: number; deviceScaleFactor: number; zoom: number };
const targetViewports = new Map<string, ViewportWant>();

function layoutSize(want: ViewportWant): { width: number; height: number } {
  const z = want.zoom > 0 ? want.zoom : 1;
  return {
    width: Math.min(Math.max(Math.round(want.width / z), 320), 3840),
    height: Math.min(Math.max(Math.round(want.height / z), 240), 2160),
  };
}
// fitViewportToContent 放宽后的布局，按 target 记住。它原本只活在 producer 里：
// viewer 全走 + 5s linger 到期 → producer 拆掉 → 放宽布局丢失 → 下次建流先按基础
// 布局起（页面重排、内容显大），1.2s 后 fit 又放宽回去（再重排、内容显小）——
// 用户每次切走再回来都看到一次「放大再缩小」（2026-08-02 Playwright 实测:
// 恢复后帧宽 661 → 1250）。记住它，重建的 producer 直接按放宽布局起流。
const fittedLayouts = new Map<string, { width: number; height: number }>();
const sessionCdpBases = new Map<string, string>();                    // sessionId -> ws://host:9223

function targetKey(sessionId: string, targetId: string): string {
  return `${sessionId}:${targetId}`;
}

/** Single teardown path for everything we hold per target: viewport socket,
 *  remembered viewport, producer + its viewers/timer, and any in-flight setup.
 *  Anything that forgets one of these in isolation leaks the others. */
export function forgetTargetViewport(sessionId: string, targetId?: string): void {
  // A target that is gone cannot be under anyone's control — drop its lease so
  // the row does not outlive the page it guarded.
  void forgetTargetLeases(sessionId, targetId);
  const drop = (k: string) => {
    const sock = targetViewportSockets.get(k);
    if (sock) { try { sock.terminate(); } catch { /* already gone */ } }
    targetViewportSockets.delete(k);
    targetViewports.delete(k);
    fittedLayouts.delete(k);
    viewportSocketsOpening.delete(k);
    producersStarting.delete(k);
    const producer = producers.get(k);
    if (producer) {
      producer.closed = true;
      if (producer.stopTimer) clearTimeout(producer.stopTimer);
      if (producer.firstFrameTimer) clearTimeout(producer.firstFrameTimer);
      if (producer.reconfigureTimer) clearTimeout(producer.reconfigureTimer);
      if (producer.visibilityTimer) clearTimeout(producer.visibilityTimer);
      clearIdleStill(producer);
      producer.lastFrame = null;
      for (const viewer of producer.viewers) {
        try { viewer.close(); } catch { /* already gone */ }
      }
      producer.viewers.clear();
      try { producer.socket.close(); } catch { /* already gone */ }
      producers.delete(k);
    }
  };
  if (targetId) return drop(targetKey(sessionId, targetId));
  const prefix = `${sessionId}:`;
  const keys = new Set([
    ...targetViewportSockets.keys(), ...targetViewports.keys(), ...producers.keys(),
  ]);
  for (const k of keys) if (k.startsWith(prefix)) drop(k);
  sessionCdpBases.delete(sessionId);
}

// Test seam: the producer opens a raw devtools socket, which unit tests cannot
// reach. Injecting the factory (and the CDP base) lets tests drive the real
// concurrency/lifecycle code with a fake socket instead of asserting on mocks.
type CastSocketFactory = (url: string) => WebSocket;
let castSocketFactory: CastSocketFactory = (url) => new WebSocket(url);

export function setCastTestHooks(hooks: {
  socketFactory?: CastSocketFactory;
  cdpBase?: { sessionId: string; base: string };
}): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setCastTestHooks can only be used when NODE_ENV=test");
  }
  if (hooks.socketFactory) castSocketFactory = hooks.socketFactory;
  if (hooks.cdpBase) sessionCdpBases.set(hooks.cdpBase.sessionId, hooks.cdpBase.base);
}

export function resetCastTestHooks(): void {
  castSocketFactory = (url) => new WebSocket(url);
  producers.clear();
  producersStarting.clear();
  targetViewports.clear();
  targetViewportSockets.clear();
  viewportSocketsOpening.clear();
  sessionCdpBases.clear();
}

const viewportSocketsOpening = new Map<string, Promise<WebSocket>>();

async function openViewportSocket(sessionId: string, targetId: string): Promise<WebSocket> {
  const key = targetKey(sessionId, targetId);
  const existing = targetViewportSockets.get(key);
  if (existing && existing.readyState === WebSocket.OPEN) return existing;
  // Same race as producers: concurrent viewport calls would each open a socket
  // and all but the last would leak.
  const pending = viewportSocketsOpening.get(key);
  if (pending) return pending;
  const task = openViewportSocketInner(sessionId, targetId, key).finally(() => {
    if (viewportSocketsOpening.get(key) === task) viewportSocketsOpening.delete(key);
  });
  viewportSocketsOpening.set(key, task);
  return task;
}

async function openViewportSocketInner(
  sessionId: string, targetId: string, key: string
): Promise<WebSocket> {
  const base = sessionCdpBases.get(sessionId);
  if (!base) throw new Error(`No CDP base for session ${sessionId}`);
  const sock = castSocketFactory(`${base}/devtools/page/${targetId}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Don't leave a socket that may still connect later with nobody holding it.
      try { sock.terminate(); } catch { /* nothing to close */ }
      reject(new Error("viewport socket timeout"));
    }, 8000);
    sock.once("open", () => { clearTimeout(timer); resolve(); });
    sock.once("error", (err) => { clearTimeout(timer); try { sock.terminate(); } catch { /**/ } reject(err); });
  });
  // The page can go away under us (closed tab, crashed renderer): drop the
  // handle so the next call reconnects instead of writing into a dead socket.
  sock.on("close", () => {
    if (targetViewportSockets.get(key) === sock) targetViewportSockets.delete(key);
  });
  sock.on("error", () => { /* surfaced via close */ });
  targetViewportSockets.set(key, sock);
  return sock;
}

let viewportCmdId = 1;

export async function setTargetViewport(
  sessionId: string,
  targetId: string,
  width: number,
  height: number,
  deviceScaleFactor = 1,
  zoom = 1
): Promise<void> {
  if (cdpServiceOverrides.setTargetViewport) {
    return cdpServiceOverrides.setTargetViewport(sessionId, targetId, width, height, deviceScaleFactor, zoom);
  }
  // Open first: remembering a viewport for a target that doesn't exist would
  // leave an entry nothing ever cleans up.
  const sock = await openViewportSocket(sessionId, targetId);
  const want: ViewportWant = { width, height, deviceScaleFactor, zoom };
  targetViewports.set(targetKey(sessionId, targetId), want);
  // Pane size / zoom changed: the remembered widened layout was computed against
  // the old base and no longer applies. The fit pass re-derives it if still needed.
  fittedLayouts.delete(targetKey(sessionId, targetId));
  const layout = layoutSize(want);
  const id = viewportCmdId++;
  // Wait for the reply: a silent send hides protocol errors, and "the viewport
  // didn't change but every HTTP call returned 200" is exactly the kind of
  // failure that costs hours to track down.
  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { sock.off("message", onMsg); reject(new Error("viewport command timeout")); }, 8000);
    function onMsg(raw: WebSocket.RawData) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      sock.off("message", onMsg);
      resolve(msg);
    }
    sock.on("message", onMsg);
  });
  sock.send(JSON.stringify({
    id,
    method: "Emulation.setDeviceMetricsOverride",
    params: {
      width: layout.width, height: layout.height, deviceScaleFactor, mobile: false,
      screenWidth: layout.width, screenHeight: layout.height, dontSetVisibleSize: false,
    },
  }));
  const resp = await reply;
  if (resp.error) {
    console.warn(`[cdp] viewport ${width}x${height} rejected for ${targetId}:`, JSON.stringify(resp.error));
    throw new Error(JSON.stringify(resp.error));
  }
  console.info(`[cdp] viewport ${layout.width}x${layout.height} ` +
    `(pane ${width}x${height} @${Math.round(zoom * 100)}%) applied to target ${targetId}`);
  // If we're already streaming this target, re-assert on the producer's session
  // (that's the one the compositor listens to) and restart the stream.
  await applyViewportToProducer(sessionId, targetId);
}

/** Re-assert the remembered viewport. Steel's cast handler resets device metrics
 *  from session.dimensions on every viewer connect, so viewers call this once
 *  their stream is up. */
export async function reapplyTargetViewport(sessionId: string, targetId: string): Promise<boolean> {
  const want = targetViewports.get(targetKey(sessionId, targetId));
  if (!want) return false;
  // `zoom` must be carried through: omitting it silently re-applies at 100% and
  // throws away whatever gear the user picked.
  await setTargetViewport(sessionId, targetId, want.width, want.height,
                          want.deviceScaleFactor, want.zoom);
  return true;
}

// ── Own screencast producer (one per target, fan-out to many viewers) ──────
// Why we don't just proxy Steel's /v1/sessions/cast: it starts the screencast in
// *its own* CDP session, and the compositor honours that session's device
// metrics. Anything we set from a second connection changes what JS on the page
// reports but not what gets rendered — measured. Owning the producer means the
// same session sets the viewport and starts the stream, so the page actually
// reflows to the pane width.
type CastProducer = {
  socket: WebSocket;
  viewers: Set<WebSocket>;
  /// Most recent jpeg *with the metadata it was rendered under*, so a joining
  /// viewer paints immediately **and can map clicks**. Storing only the bytes was
  /// a bug: a joiner on a static page got a picture with no layout, and since a
  /// still page produces no further frames it could stay un-clickable forever.
  lastFrame: { data: string; revision: number; width: number; height: number } | null;
  url: string;
  title: string;
  cmdId: number;
  stopTimer: NodeJS.Timeout | null;
  firstFrameTimer: NodeJS.Timeout | null;
  closed: boolean;
  /// Bumped whenever the layout viewport changes. Input carries the revision it
  /// was aimed at; anything older is dropped, because a click computed against a
  /// stale frame lands somewhere else after the page re-laid out.
  viewportRevision: number;
  /// Password field focused → stop shipping frames entirely. A rendered password
  /// is dots, but the surrounding page (and typing feedback) still leaks.
  masked: boolean;
  /// Per-control-connection held state. This is deliberately **not** shared on the
  /// producer: with one global set, a stale control socket closing mid-drag would
  /// synthesise mouseReleased/keyUp and wipe the *current* holder's state — a
  /// single-writer violation, not just a glitch (codex review 2026-08-02, High-1).
  controllers: Map<WebSocket, ControllerState>;
  /// Layout we asked Chrome for but have not yet seen a frame from. While this is
  /// set the stream is in transition: frames still in flight were rendered against
  /// the *old* layout, so publishing the new revision now would stamp stale pixels
  /// as current and let stale coordinates pass validation (High-3).
  pendingLayout: { width: number; height: number } | null;
  reconfigureTimer: NodeJS.Timeout | null;
  /// Layout the current stream is rendering at, learned from frame metadata.
  /// Needed to ask for a still of exactly the same region.
  layout: { width: number; height: number } | null;
  /// Viewport the current stream was started with, so a recovery restart can
  /// reproduce it without re-deriving it from the maps.
  lastWant: ViewportWant | null;
  /// Set while we are waiting to see whether a page Chrome reported as hidden
  /// comes back on its own. Cleared the moment it does; on expiry we escalate to
  /// actually activating the target (see onScreencastVisibility).
  visibilityTimer: NodeJS.Timeout | null;
  /// Resolution multiplier the *stream* is currently delivering (frameScale of the
  /// viewport in force when the stream was started). When it already reaches
  /// SHARP_STILL_SCALE the idle screenshot has nothing left to add, and skipping it
  /// removes the visible sharpness step between moving and still content.
  streamScale: number;
  /// Idle → grab one high-resolution still (see SHARP_STILL_SCALE).
  idleTimer: NodeJS.Timeout | null;
  stillInFlight: boolean;
  /// Counts stream frames. The sharp still records it before the (slow) screenshot
  /// round-trip and bails if it moved: `viewportRevision` alone only catches layout
  /// changes, so a stream frame arriving mid-capture would otherwise be painted
  /// over by an older still moments later (codex review 2026-08-02).
  frameSeq: number;
  /// Serialises input so `mousePressed → mouseMoved → mouseReleased` cannot be
  /// reordered by their independent lease lookups completing out of order (High-2).
  inputChain: Promise<void>;
};

type ControllerState = {
  heldButtons: Set<string>;
  heldKeys: Set<number>;
  /// The lease this connection claimed. Kept so anything that needs to know
  /// "does this connection *still* hold the write lease" can re-check instead of
  /// trusting the fact that it once presented one (codex review 2026-08-03, M4).
  leaseId: string;
};

const producers = new Map<string, CastProducer>();
// Two viewers arriving at the same instant would both find no producer and both
// create one; the second overwrites the map entry and the first becomes a zombie
// that keeps acking frames forever. Share the in-flight creation instead.
const producersStarting = new Map<string, Promise<CastProducer>>();
// Frame encoding: Chrome already hands us a base64 jpeg, so the producer only
// acks and fans out — no image work on our side.
// 70 was visibly soft on text; screencast frames are re-encoded per frame, so a
// higher quality costs bandwidth but not latency.
const CAST_QUALITY = 90;
// Keep the producer alive briefly after the last viewer leaves: switching tabs
// in the workspace pane disconnects and reconnects within a second, and tearing
// the stream down each time costs a visible black flash.
const PRODUCER_LINGER_MS = 5000;
// How long to wait for the first frame before forcing the tab to the front.
const FIRST_FRAME_FALLBACK_MS = 3000;

function producerSend(p: CastProducer, method: string, params: Record<string, unknown> = {}): void {
  if (p.socket.readyState !== WebSocket.OPEN) return;
  p.socket.send(JSON.stringify({ id: p.cmdId++, method, params }));
}

// Latest frame wins. A frame still sitting in the socket buffer has already been
// superseded by the one we are about to send, and a queued WebSocket message
// cannot be replaced — so skip rather than queue.
//
// This used to allow 4 MiB of backlog, which at ~60 KiB a frame is roughly 60
// frames: the picture stayed "live" but ran seconds behind the page, and that lag
// was most of what read as sluggishness. Zero means at most one frame in flight
// per viewer; a slow link then simply gets a lower frame rate of *current*
// frames instead of a smooth replay of the past.
const VIEWER_BUFFER_LIMIT_BYTES = 0;

// Frame pixels = layoutCss × the *launch* device scale factor
// (BROWSER_DEVICE_SCALE_FACTOR), and startScreencast's maxWidth/maxHeight can
// only scale that down — never up. The old comment here claimed frames were
// always the CSS size of the viewport; that was true only because the cap below
// used to be the CSS size, which threw the extra pixels away. See
// session-driver.ts for the measurement matrix.
//
// So the cap is what decides how much of the rendered detail a viewer receives.
// Size it by the viewer's own pixel density: a 2x display gets the full 2x frame
// (sharp), a 1x display gets it scaled down in the browser rather than over the
// wire (2x costs ~2.5-2.8x the bytes — measured on vuejs.org / HN at q90).
function frameScale(want: ViewportWant): number {
  const viewer = want.deviceScaleFactor > 0 ? want.deviceScaleFactor : 1;
  return Math.min(BROWSER_DEVICE_SCALE_FACTOR, Math.max(1, viewer));
}

function castCaps(want: ViewportWant, layout?: { width: number; height: number }) {
  const l = layout ?? layoutSize(want);
  const s = frameScale(want);
  return { maxWidth: Math.round(l.width * s), maxHeight: Math.round(l.height * s) };
}

/** The only place that starts a stream, so the cap and the `streamScale` the
 *  idle-still path reads can never drift apart. */
function startCast(
  p: CastProducer, want?: ViewportWant, layout?: { width: number; height: number },
): void {
  p.streamScale = want ? frameScale(want) : 1;
  p.lastWant = want ?? p.lastWant;
  producerSend(p, "Page.startScreencast", {
    format: "jpeg", quality: CAST_QUALITY, ...(want ? castCaps(want, layout) : {}),
  });
}

function producerRequest(
  p: CastProducer, method: string, params: Record<string, unknown> = {}, timeoutMs = 5000
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    if (p.socket.readyState !== WebSocket.OPEN) return reject(new Error("producer socket closed"));
    const id = p.cmdId++;
    const timer = setTimeout(() => { p.socket.off("message", onMsg); reject(new Error(`${method} timeout`)); }, timeoutMs);
    function onMsg(raw: WebSocket.RawData) {
      let msg: Record<string, any>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      p.socket.off("message", onMsg);
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result ?? {});
    }
    p.socket.on("message", onMsg);
    p.socket.send(JSON.stringify({ id, method, params }));
  });
}

// Sites with a fixed desktop layout (baidu.com, google.com) do not reflow: give
// them a 794px viewport and they still lay out at 1250px, so the pane grows a
// horizontal scrollbar and half the page is unreachable. Browsers solve this by
// zooming to fit the width — do the same: widen the *layout* viewport to the
// content width and let the screencast scale the frame back down to the pane.
// Responsive sites never hit this path (their scrollWidth fits the viewport).
async function fitViewportToContent(
  p: CastProducer, sessionId: string, targetId: string, want: ViewportWant
): Promise<void> {
  let scrollWidth: number;
  try {
    const res = await producerRequest(p, "Runtime.evaluate", {
      expression: "document.documentElement.scrollWidth",
      returnByValue: true,
    });
    scrollWidth = Number(res?.result?.value);
  } catch {
    return;                     // 读不到就维持原样，画面仍在，只是可能有横向滚动
  }
  if (!Number.isFinite(scrollWidth)) return;
  const fitKey = targetKey(sessionId, targetId);
  // 2% tolerance: sub-pixel rounding shouldn't trigger a re-layout.
  // Only widen when the page genuinely does not fit. Folding the DPI bump into
  // this condition (as a first cut did) widens *every* page to width*dpr, which
  // halves the apparent text size on responsive sites — they are supposed to lay
  // out at the pane width, that is the whole point of the feature.
  const base = layoutSize(want);
  if (scrollWidth <= base.width * 1.02) {
    // Content fits the base layout → any remembered widened layout is stale.
    // Keeping it would make the next producer start wide on a page that no
    // longer needs it, and this early return would never take it back down.
    fittedLayouts.delete(fitKey);
    return;
  }
  // Widen only as far as the content actually needs. This used to also widen to
  // `pane × dpr` to buy pixels for a HiDPI viewer, which cost real legibility —
  // a page needing 1250px got laid out at 1470 and its text shrank accordingly.
  // The frame now carries layout × BROWSER_DEVICE_SCALE_FACTOR pixels on its own,
  // so buying sharpness by widening the layout is no longer a trade worth making.
  const layoutWidth = Math.min(Math.round(scrollWidth), 3840);
  const layoutHeight = Math.min(
    Math.max(Math.round(base.height * (layoutWidth / base.width)), 240), 2160);
  fittedLayouts.set(fitKey, { width: layoutWidth, height: layoutHeight });
  // Already streaming at exactly this layout (a rebuilt producer started from the
  // remembered fit, or a repeat trigger): reconfiguring again would stop/start the
  // stream and reflow the page for nothing.
  if (p.layout
      && Math.abs(p.layout.width - layoutWidth) <= LAYOUT_MATCH_TOLERANCE_PX
      && Math.abs(p.layout.height - layoutHeight) <= LAYOUT_MATCH_TOLERANCE_PX) return;
  beginReconfigure(p, layoutWidth, layoutHeight);
  producerSend(p, "Emulation.setDeviceMetricsOverride", {
    width: layoutWidth, height: layoutHeight,
    deviceScaleFactor: want.deviceScaleFactor, mobile: false,
    screenWidth: layoutWidth, screenHeight: layoutHeight, dontSetVisibleSize: false,
  });
  // The cap must allow the full layout through: capping at the pane's CSS width
  // would scale the frame straight back down and undo the whole point (measured —
  // that is exactly what happened the first time). The viewer does the fitting in
  // CSS; we ship the pixels.
  producerSend(p, "Page.stopScreencast");
  startCast(p, want, { width: layoutWidth, height: layoutHeight });
  console.info(`[cast] ${targetId}: layout ${layoutWidth}px (content ${scrollWidth}px, ` +
    `pane ${want.width}px @${Math.round(want.zoom * 100)}% @${want.deviceScaleFactor}x), zoomed to fit`);
}

// A viewport change is not instantaneous: `setDeviceMetricsOverride` +
// stop/startScreencast are fire-and-forget, and frames already queued on the CDP
// socket were rendered against the previous layout. Bumping the revision at
// request time therefore stamps stale pixels with the new number — the viewer
// draws an old layout, echoes the new revision back, and its coordinates pass
// validation while pointing at the wrong place. Instead: record what we asked
// for, hold the revision, and publish it only once a frame whose metadata matches
// the requested layout actually arrives.
const RECONFIGURE_CONFIRM_TIMEOUT_MS = 3000;
// Chrome reports the visual viewport in CSS px; rounding differs by a pixel or
// two between our request and its metadata.
const LAYOUT_MATCH_TOLERANCE_PX = 4;

function beginReconfigure(p: CastProducer, width: number, height: number): void {
  p.pendingLayout = { width, height };
  if (p.reconfigureTimer) clearTimeout(p.reconfigureTimer);
  // Safety net: if the metadata never matches (an emulation quirk, a page that
  // forces its own size), publishing anyway beats freezing the stream forever.
  p.reconfigureTimer = setTimeout(() => {
    if (p.closed || !p.pendingLayout) return;
    console.warn("[cast] reconfigure not confirmed by any frame; publishing anyway");
    // The cached frame predates this layout; handing it to a joiner under the new
    // revision would let stale coordinates pass validation.
    p.lastFrame = null;
    finishReconfigure(p);
  }, RECONFIGURE_CONFIRM_TIMEOUT_MS);
}

function finishReconfigure(p: CastProducer): void {
  if (p.reconfigureTimer) { clearTimeout(p.reconfigureTimer); p.reconfigureTimer = null; }
  p.pendingLayout = null;
  p.viewportRevision += 1;
}

/** Does this frame come from the layout we are waiting for? */
function frameMatchesPendingLayout(p: CastProducer, metadata: any): boolean {
  if (!p.pendingLayout) return false;
  const w = Number(metadata?.deviceWidth);
  const h = Number(metadata?.deviceHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
  return Math.abs(w - p.pendingLayout.width) <= LAYOUT_MATCH_TOLERANCE_PX
    && Math.abs(h - p.pendingLayout.height) <= LAYOUT_MATCH_TOLERANCE_PX;
}

// Screencast frames are always the CSS size of the visual viewport — measured, and
// neither deviceScaleFactor nor setPageScaleFactor changes it. So on a 2x display
// every frame is upscaled, and JPEG ringing lands exactly on text edges. There is
// no way to make the *stream* sharper.
//
// `Page.captureScreenshot` is a different command and its `clip.scale` does apply.
// So: while the page is moving, ship the (soft) stream; the moment it settles,
// grab one screenshot at 2x and send it as the current frame. Motion stays smooth,
// still content becomes crisp — the same trade every remote-desktop protocol makes.
const SHARP_STILL_SCALE = 2;
const SHARP_STILL_QUALITY = 92;
const IDLE_BEFORE_STILL_MS = 250;
// Bound the payload: a 2x still of a very wide fitted layout gets big fast.
const SHARP_STILL_MAX_WIDTH = 2560;

function clearIdleStill(p: CastProducer): void {
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }
}

function scheduleIdleStill(p: CastProducer): void {
  clearIdleStill(p);
  if (p.closed || p.masked || p.pendingLayout || !p.layout) return;
  // The stream already carries at least as many pixels as the still would add.
  // Taking it anyway would cost a screenshot round-trip per pause for an image
  // the viewer cannot tell apart — and it is that swap, not the still itself,
  // that users see as the picture "settling" a moment after it stops moving.
  if (p.streamScale >= SHARP_STILL_SCALE) return;
  if (Math.round(p.layout.width * SHARP_STILL_SCALE) > SHARP_STILL_MAX_WIDTH) return;
  p.idleTimer = setTimeout(() => { void captureSharpStill(p); }, IDLE_BEFORE_STILL_MS);
}

async function captureSharpStill(p: CastProducer): Promise<void> {
  // Re-check everything: 250ms is plenty of time for the page to be masked, torn
  // down or re-laid-out. Capturing while masked would hand out the password screen
  // at higher resolution than the stream we just refused to send.
  if (p.closed || p.masked || p.pendingLayout || p.stillInFlight || !p.layout) return;
  if (p.viewers.size === 0) return;
  p.stillInFlight = true;
  const at = p.viewportRevision;
  const seqAt = p.frameSeq;
  const { width, height } = p.layout;
  try {
    // Must run on the producer's own CDP session: the viewport is per-session
    // state, so a screenshot taken from another connection can come back with a
    // different layout than the stream is showing.
    const res = await producerRequest(p, "Page.captureScreenshot", {
      format: "jpeg", quality: SHARP_STILL_QUALITY, captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale: SHARP_STILL_SCALE },
    });
    const data = res?.data as string | undefined;
    if (!data) return;
    // Anything that happened while the screenshot was being taken invalidates it —
    // including a newer *stream* frame: the page moved, this still shows the past.
    if (p.closed || p.masked || p.pendingLayout || p.viewportRevision !== at
        || p.frameSeq !== seqAt) return;
    // joiners get the crisp one too — with the layout it was taken at
    p.lastFrame = { data, revision: p.viewportRevision, width, height };
    broadcastFrame(p, data, { skipIdleReschedule: true });
  } catch {
    /* a failed still just means the soft stream frame stays on screen */
  } finally {
    p.stillInFlight = false;
  }
}

// Skipping a frame is only safe if another one is coming. It usually is — but not
// always: the last frame before a page goes still, and the sharp still that follows
// it, can both land while the socket is busy, and then nothing ever triggers a send
// again (the still deliberately does not reschedule itself). Non-frame messages such
// as `masked` also occupy `bufferedAmount` and can cause the same stall. So keep one
// overwritable frame per viewer and retry once the socket drains.
const viewerPendingFrame = new WeakMap<WebSocket, string>();
const viewerDrainTimer = new WeakMap<WebSocket, NodeJS.Timeout>();
const DRAIN_RETRY_MS = 50;

function sendLatestFrame(viewer: WebSocket, payload: string): void {
  if (viewer.readyState !== WebSocket.OPEN) return;
  if (viewer.bufferedAmount > VIEWER_BUFFER_LIMIT_BYTES) {
    viewerPendingFrame.set(viewer, payload);   // overwrite: only the newest matters
    scheduleDrainRetry(viewer);
    return;
  }
  viewerPendingFrame.delete(viewer);
  viewer.send(payload);
}

function scheduleDrainRetry(viewer: WebSocket): void {
  if (viewerDrainTimer.has(viewer)) return;
  const timer = setTimeout(() => {
    viewerDrainTimer.delete(viewer);
    const held = viewerPendingFrame.get(viewer);
    if (held === undefined) return;
    if (viewer.readyState !== WebSocket.OPEN) { viewerPendingFrame.delete(viewer); return; }
    if (viewer.bufferedAmount > VIEWER_BUFFER_LIMIT_BYTES) { scheduleDrainRetry(viewer); return; }
    viewerPendingFrame.delete(viewer);
    viewer.send(held);
  }, DRAIN_RETRY_MS);
  timer.unref?.();
  viewerDrainTimer.set(viewer, timer);
}

function broadcastFrame(
  p: CastProducer, data: string, opts: { skipIdleReschedule?: boolean } = {}
): void {
  if (p.masked) return;   // password field focused: ship nothing at all
  if (p.pendingLayout) return;   // mid-reconfigure: these pixels are the old layout
  // `layout` is the remote CSS viewport this frame was rendered for. The viewer
  // needs it to map clicks: it cannot infer it from the image, because a sharp
  // still is 2x the layout while a stream frame is 1x — using image width would
  // put every click at half coordinates on stills.
  const payload = JSON.stringify({
    data, url: p.url, title: p.title, favicon: null,
    revision: p.viewportRevision,
    layoutWidth: p.layout?.width ?? null,
    layoutHeight: p.layout?.height ?? null,
  });
  for (const viewer of p.viewers) sendLatestFrame(viewer, payload);
  //每帧都重排空闲计时：动的时候永远不触发，一停下来就补高清。
  if (!opts.skipIdleReschedule) scheduleIdleStill(p);
}

async function createProducer(sessionId: string, targetId: string): Promise<CastProducer> {
  const base = sessionCdpBases.get(sessionId);
  if (!base) throw new Error(`No CDP base for session ${sessionId}`);
  const socket = castSocketFactory(`${base}/devtools/page/${targetId}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cast socket timeout")), 10000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });

  const p: CastProducer = {
    socket, viewers: new Set(), lastFrame: null,
    url: "", title: "", cmdId: 1, stopTimer: null, firstFrameTimer: null, closed: false,
    viewportRevision: 1, masked: false, controllers: new Map(),
    pendingLayout: null, reconfigureTimer: null, inputChain: Promise.resolve(),
    layout: null, streamScale: 1, lastWant: null, visibilityTimer: null,
    idleTimer: null, stillInFlight: false, frameSeq: 0,
  };

  socket.on("message", (raw: WebSocket.RawData) => {
    let msg: Record<string, any>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.method === "Page.screencastFrame") {
      const data = msg.params?.data as string | undefined;
      const ackId = msg.params?.sessionId;
      // Ack first: Chrome stalls the stream until the previous frame is acked.
      if (ackId !== undefined) producerSend(p, "Page.screencastFrameAck", { sessionId: ackId });
      if (data) {
        if (p.firstFrameTimer) { clearTimeout(p.firstFrameTimer); p.firstFrameTimer = null; }
        clearVisibilityRecovery(p);
        // First frame confirmed to be from the layout we requested → publish the
        // new revision now (and only now), then let this frame through with it.
        if (p.pendingLayout && frameMatchesPendingLayout(p, msg.params?.metadata)) {
          finishReconfigure(p);
        }
        // Learn the layout the stream is actually rendering at — the sharp-still
        // capture needs to clip exactly this region.
        const mw = Number(msg.params?.metadata?.deviceWidth);
        const mh = Number(msg.params?.metadata?.deviceHeight);
        if (Number.isFinite(mw) && Number.isFinite(mh) && mw > 0 && mh > 0) {
          p.layout = { width: Math.round(mw), height: Math.round(mh) };
        }
        // While masked we neither ship nor **retain** the frame: a cached frame
        // would be handed to the next viewer that connects, which is exactly the
        // password screen we are trying not to show.
        // Never cache mid-reconfigure: those pixels belong to the old layout, and
        // the timeout fallback would later hand them out stamped with a new revision.
        if (!p.masked && !p.pendingLayout && p.layout) {
          p.lastFrame = {
            data, revision: p.viewportRevision,
            width: p.layout.width, height: p.layout.height,
          };
        }
        p.frameSeq++;
        broadcastFrame(p, data);
      }
      return;
    }
    // Chrome tells us outright when it stops considering the page visible — no
    // need to infer a freeze from frame timing. This is the safety net behind
    // focus emulation: if that ever fails to hold (a Chrome change, a navigation
    // that drops the override), we still notice instead of showing a dead picture.
    if (msg.method === "Page.screencastVisibilityChanged") {
      onScreencastVisibility(p, targetId, msg.params?.visible !== false);
      return;
    }
    if (msg.method === "Runtime.bindingCalled"
        && msg.params?.name === "__browsermint_password_focus") {
      const on = msg.params?.payload === "1";
      if (on !== p.masked) {
        p.masked = on;
        for (const viewer of p.viewers) {
          if (viewer.readyState === WebSocket.OPEN) {
            viewer.send(JSON.stringify({ type: "masked", masked: on }));
          }
        }
        // Cancel any pending sharp still as well: captureSharpStill re-checks
        // `masked` before firing, but leaving the timer armed is one more way for
        // a future edit to leak the password screen at higher resolution.
        if (on) { clearIdleStill(p); p.lastFrame = null; }   // don't let a new viewer paint the old frame
        console.info(`[cast] ${targetId}: password field ${on ? "focused — masking" : "left — unmasked"}`);
      }
      return;
    }
    if (msg.method === "Page.frameNavigated" && msg.params?.frame?.parentId === undefined) {
      p.url = msg.params.frame.url ?? p.url;
      // Focus emulation is CDP session state and a main-frame navigation is the
      // most likely moment for it to be dropped. Re-asserting costs one message.
      // It belongs *inside* this branch: an earlier branch of its own would have
      // to return, and returning here silently kills the url/tabUpdate/fit work
      // below (codex review 2026-08-03, High-1 — that is exactly what it did).
      producerSend(p, "Emulation.setFocusEmulationEnabled", { enabled: true });
      // A different page may have a different minimum layout width — the layout
      // remembered for the previous page must not survive the navigation (a
      // producer rebuilt before the fit pass below would start from it).
      fittedLayouts.delete(targetKey(sessionId, targetId));
      const wantNow = targetViewports.get(targetKey(sessionId, targetId));
      if (wantNow) {
        setTimeout(() => {
          if (!p.closed) fitViewportToContent(p, sessionId, targetId, wantNow).catch(() => {});
        }, 1500);
      }
      for (const viewer of p.viewers) {
        if (viewer.readyState === WebSocket.OPEN) {
          viewer.send(JSON.stringify({ type: "tabUpdate", url: p.url, title: p.title, favicon: null }));
        }
      }
    }
  });

  socket.on("close", () => {
    p.closed = true;
    p.lastFrame = null;          // release the retained JPEG
    if (p.stopTimer) { clearTimeout(p.stopTimer); p.stopTimer = null; }
    if (p.firstFrameTimer) { clearTimeout(p.firstFrameTimer); p.firstFrameTimer = null; }
    if (p.reconfigureTimer) { clearTimeout(p.reconfigureTimer); p.reconfigureTimer = null; }
    if (p.visibilityTimer) { clearTimeout(p.visibilityTimer); p.visibilityTimer = null; }
    clearIdleStill(p);
    if (producers.get(targetKey(sessionId, targetId)) === p) {
      producers.delete(targetKey(sessionId, targetId));
    }
    // The page went away (closed tab, crashed renderer): tell viewers so they
    // stop waiting for frames that will never come.
    for (const viewer of p.viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(JSON.stringify({ type: "targetClosed", pageId: targetId }));
        viewer.close();
      }
    }
    p.viewers.clear();
  });
  socket.on("error", () => { /* surfaced via close */ });

  producers.set(targetKey(sessionId, targetId), p);

  // Order matters: viewport first, then start the stream — the frames must be
  // rendered at the size we asked for, not resized after the fact.
  const want = targetViewports.get(targetKey(sessionId, targetId));
  // A rebuilt producer must start at the layout the page was last streaming at.
  // Starting at the base layout reflows the page (content jumps bigger), then the
  // fit pass 1.2s later widens it back (content jumps smaller) — a guaranteed
  // zoom-in/zoom-out on every tab-away-and-back once the linger window expired.
  const fitted = fittedLayouts.get(targetKey(sessionId, targetId));
  const layout = fitted ?? (want ? layoutSize(want) : null);
  producerSend(p, "Page.enable");
  installPasswordWatch(p);
  // Chrome only emits screencast frames for a page it considers *visible*, and a
  // page loses that the moment another tab in its window is selected. That is not
  // a corner case: clicking any `target=_blank` link (every Baidu/Google result)
  // opens a tab that takes the foreground, and the page being watched freezes
  // solid — the picture keeps its last frame forever, so nothing looks broken.
  //
  // setWebLifecycleState only lifts the *frozen* page-lifecycle state; it does not
  // make the widget visible. Measured on this image (8 stimulus rounds each):
  //   baseline                                  foreground 8/8, background 0/8
  //   --disable-renderer-backgrounding & co.    foreground 8/8, background 0/8
  //   setFocusEmulationEnabled(true)            foreground 8/8, background 8/8
  // Focus emulation is scoped to this CDP session, so it lives exactly as long as
  // the producer does (see the disable in scheduleLingerIfIdle): pages nobody is
  // watching go back to normal visibility semantics.
  producerSend(p, "Page.setWebLifecycleState", { state: "active" });
  producerSend(p, "Emulation.setFocusEmulationEnabled", { enabled: true });
  if (want && layout) {
    producerSend(p, "Emulation.setDeviceMetricsOverride", {
      width: layout.width, height: layout.height, deviceScaleFactor: want.deviceScaleFactor,
      mobile: false, screenWidth: layout.width, screenHeight: layout.height,
      dontSetVisibleSize: false,
    });
  }
  startCast(p, want && layout ? want : undefined, layout ?? undefined);
  // setWebLifecycleState is the polite way to make Chrome consider this page
  // active, but it is not sufficient in every state we've observed (a target
  // that Chrome treats as fully backgrounded stays silent). If no frame arrives
  // shortly, fall back to actually activating the tab — worse for a concurrently
  // working agent, but a viewer with no picture at all is worse still.
  if (want) {
    // Give the page a moment to lay out before measuring its content width.
    setTimeout(() => {
      if (!p.closed) fitViewportToContent(p, sessionId, targetId, want).catch(() => {});
    }, 1200);
  }
  p.firstFrameTimer = setTimeout(() => {
    p.firstFrameTimer = null;
    if (p.closed || p.lastFrame) return;
    console.info(`[cast] no frame for ${targetId} yet, activating target`);
    executeCdpCommand(sessionId, "Target.activateTarget", { targetId })
      .then(() => {
        if (p.closed) return;
        producerSend(p, "Page.startScreencast", {
          format: "jpeg", quality: CAST_QUALITY,
          ...(layout ? { maxWidth: layout.width, maxHeight: layout.height } : {}),
        });
      })
      .catch((err) => console.warn(`[cast] activate fallback failed for ${targetId}:`, err));
  }, FIRST_FRAME_FALLBACK_MS);
  console.info(`[cast] producer started for ${targetId}` + (want ? ` @${want.width}x${want.height}` : ""));
  return p;
}

// How long to wait after a hidden report before trying the stream itself again.
const VISIBILITY_RECOVER_MS = 2500;

/** Chrome says this page is (in)visible. Invisible while someone is watching is
 *  the freeze — recover, but **never by taking the foreground**.
 *
 *  Stealing the foreground here was the first design and it was wrong (codex
 *  review 2026-08-03, High-2): `viewers` includes read-only viewers, so a second
 *  person merely *watching* a background page would yank the foreground away from
 *  the agent working under a lease in another tab of the same window — a
 *  single-writer violation dressed up as a recovery. Worse, with two producers it
 *  is mutually recursive: A activates → B goes hidden → B activates → A goes
 *  hidden, every 2.5s forever. Anything that needs the foreground has to go
 *  through the lease, and this code path has no business having one. */
function onScreencastVisibility(
  p: CastProducer, targetId: string, visible: boolean,
): void {
  if (visible) {
    clearVisibilityRecovery(p);
    return;
  }
  // Nobody is looking: a hidden page that produces nothing is exactly right.
  if (p.viewers.size === 0 || p.closed) return;
  // Re-assert focus emulation — this alone fixes it whenever the override was
  // simply lost, and it disturbs nobody else.
  producerSend(p, "Emulation.setFocusEmulationEnabled", { enabled: true });
  if (p.visibilityTimer) return;
  p.visibilityTimer = setTimeout(() => {
    p.visibilityTimer = null;
    if (p.closed || p.viewers.size === 0) return;
    // Still nothing. Restart the stream on our own session: harmless to every
    // other target, and it re-runs the whole setup including the override.
    // If even this does not help, the picture stays frozen — but a stuck frame
    // is strictly better than fighting the agent for the foreground. The viewer
    // still has a manual way out (reload the page from the address bar).
    console.info(`[cast] ${targetId} still hidden with ${p.viewers.size} viewer(s), restarting stream`);
    producerSend(p, "Emulation.setFocusEmulationEnabled", { enabled: true });
    producerSend(p, "Page.stopScreencast");
    const want = p.lastWant;
    startCast(p, want ?? undefined, p.layout ?? undefined);
  }, VISIBILITY_RECOVER_MS);
}

/** A frame proves the page is producing again — no report needed to tell us. */
function clearVisibilityRecovery(p: CastProducer): void {
  if (p.visibilityTimer) { clearTimeout(p.visibilityTimer); p.visibilityTimer = null; }
}

/** A page opened another page (a `target=_blank` link, `window.open`, a form with
 *  a target). Tell whoever is watching the page it came from, so the platform can
 *  give the new page an identity instead of it existing only inside Chrome.
 *
 *  `initiated` separates "you did this" from "this happened": only the connection
 *  holding the write lease is treated as the originator and should follow the new
 *  page. Everyone else gets the same notice as a cue to refresh their page list —
 *  auto-switching every window would be the focus-stealing bug in a new costume. */
// 「这个 target 是从那个 target 开出来的」——只有 attachedToTarget 那一瞬间知道。
// 事后 `Target.getTargets` **不再带 openerId**（实测：刚建时有，之后只剩
// canAccessOpener=false），所以平台没法回头去核对，只能由我们记下来背书。
// 平台据此判断收编请求是否可信；没有这条记录就不许收编（codex 复审 High-1）。
const CHILD_ORIGIN_TTL_MS = 5 * 60_000;
const childOrigins = new Map<string, { openerTargetId: string; at: number }>();

function childOriginKey(sessionId: string, targetId: string): string {
  return `${sessionId}:${targetId}`;
}

function rememberChildOrigin(sessionId: string, childTargetId: string, openerTargetId: string): void {
  const now = Date.now();
  for (const [k, v] of childOrigins) {
    if (now - v.at > CHILD_ORIGIN_TTL_MS) childOrigins.delete(k);
  }
  childOrigins.set(childOriginKey(sessionId, childTargetId), { openerTargetId, at: now });
}

/** 平台收编前问这一句：这个 target 到底是谁开出来的？不知道就返回 null。 */
export function lookupChildOrigin(sessionId: string, childTargetId: string): string | null {
  const hit = childOrigins.get(childOriginKey(sessionId, childTargetId));
  if (!hit) return null;
  if (Date.now() - hit.at > CHILD_ORIGIN_TTL_MS) {
    childOrigins.delete(childOriginKey(sessionId, childTargetId));
    return null;
  }
  return hit.openerTargetId;
}

export function notifyChildTarget(
  sessionId: string, openerTargetId: string,
  child: { targetId: string; url?: string },
): void {
  // 先记账再判断有没有人在看：即便此刻没有观看端（agent 自己点出来的页面），
  // 这条来源关系照样是收编时唯一可信的依据。
  rememberChildOrigin(sessionId, child.targetId, openerTargetId);
  void notifyChildTargetViewers(sessionId, openerTargetId, child);
}

async function notifyChildTargetViewers(
  sessionId: string, openerTargetId: string,
  child: { targetId: string; url?: string },
): Promise<void> {
  const p = producers.get(targetKey(sessionId, openerTargetId));
  if (!p || p.closed || p.viewers.size === 0) return;
  // Presenting a lease once is not the same as still holding it: leases expire and
  // can be taken over while the socket stays open. Re-check now, so a connection
  // that lost the lease minutes ago is not told it "initiated" this
  // (codex review 2026-08-03, M4).
  const holders = new Set<WebSocket>();
  await Promise.all([...p.controllers].map(async ([viewer, state]) => {
    try {
      if (await holdsLease(sessionId, openerTargetId, state.leaseId)) holders.add(viewer);
    } catch { /* fail closed: treat as not holding */ }
  }));
  for (const viewer of p.viewers) {
    if (viewer.readyState !== WebSocket.OPEN) continue;
    const payload = {
      type: "childTarget",
      targetId: child.targetId,
      url: child.url ?? null,
      openerTargetId,
      // A page can open another page with no user involved at all (script on
      // load, a redirect chain). Then nobody "initiated" it and nobody follows.
      // This is a UX hint only — the platform still proves provenance server-side
      // before it will adopt anything.
      initiated: holders.has(viewer),
    };
    try { viewer.send(JSON.stringify(payload)); } catch { /* viewer went away */ }
  }
  console.info(`[cast] ${openerTargetId} opened ${child.targetId}, told ${p.viewers.size} viewer(s)`);
}

function scheduleLingerIfIdle(producer: CastProducer, key: string, targetId: string): void {
  if (producer.viewers.size > 0 || producer.closed) return;
  // 'close' and 'error' can both fire for the same viewer: without clearing, the
  // second call leaves an orphan timer that fires against a producer that has
  // already been stopped (and possibly replaced).
  if (producer.stopTimer) clearTimeout(producer.stopTimer);
  producer.stopTimer = setTimeout(() => {
    if (producer.viewers.size > 0 || producer.closed) return;
    // Hand the page back its real visibility semantics. Leaving focus emulation on
    // would make every page anyone ever watched believe it is focused forever,
    // which quietly changes how sites behave (blur-pause, autoplay, idle timers)
    // long after the last viewer left.
    producerSend(producer, "Emulation.setFocusEmulationEnabled", { enabled: false });
    producerSend(producer, "Page.stopScreencast");
    try { producer.socket.close(); } catch { /* already gone */ }
    // Only drop the entry if it is still ours — a reconnect during the linger
    // window may already have installed a fresh producer under this key.
    if (producers.get(key) === producer) producers.delete(key);
    console.info(`[cast] producer stopped for ${targetId} (no viewers)`);
  }, PRODUCER_LINGER_MS);
}

/** The session token is session-wide, so a caller could name any targetId in
 *  the session. Today the platform BFF only ever passes a targetId taken from a
 *  ticket-bound page record, but check the target exists and is a page anyway:
 *  streaming a worker/iframe target is meaningless, and this is the seam where a
 *  future target-level isolation model would have to hold. */
async function assertPageTarget(sessionId: string, targetId: string): Promise<void> {
  const res = await executeCdpCommand(sessionId, "Target.getTargets");
  const infos = (res.targetInfos ?? []) as Array<{ targetId: string; type: string }>;
  const hit = infos.find((t) => t.targetId === targetId);
  if (!hit) throw new Error(`target ${targetId} not found in session ${sessionId}`);
  if (hit.type !== "page") throw new Error(`target ${targetId} is ${hit.type}, not a page`);
}

// Page script that reports focus entering/leaving a password field. CDP has no
// "focus is on a password input" event, so we watch focusin/focusout in the page
// and report through a binding — the same mechanism the stealth injection uses.
// Caveat worth stating plainly: this reliably covers native input[type=password]
// only. Custom widgets and "show password" toggles are not covered, and the
// agent's own CDP can still read the DOM — so masking is defence in depth, not a
// guarantee. Real secrecy also requires the agent to be fenced off (it is,
// during a takeover).
const PASSWORD_WATCH_SCRIPT = `(() => {
  if (window.__bm_pw_watch) return; window.__bm_pw_watch = true;
  const isPw = (el) => !!el && el.tagName === 'INPUT' && el.type === 'password';
  const report = (on) => { try { window.__browsermint_password_focus(on ? '1' : '0'); } catch (e) {} };
  document.addEventListener('focusin', (e) => { if (isPw(e.target)) report(true); }, true);
  document.addEventListener('focusout', (e) => { if (isPw(e.target)) report(false); }, true);
  if (isPw(document.activeElement)) report(true);
})()`;

function installPasswordWatch(p: CastProducer): void {
  producerSend(p, "Runtime.enable");
  producerSend(p, "Runtime.addBinding", { name: "__browsermint_password_focus" });
  producerSend(p, "Page.addScriptToEvaluateOnNewDocument", { source: PASSWORD_WATCH_SCRIPT });
  producerSend(p, "Runtime.evaluate", { expression: PASSWORD_WATCH_SCRIPT });
}

/** CDP `buttons` is a bitmask of the buttons currently held — not the button that
 *  triggered this event. The viewer never sends it, and defaulting it to 0 tells
 *  Chrome "a press happened while nothing is pressed": the click is delivered but
 *  drags and text selection never start, because every mouseMoved in between also
 *  claims no button is down. We already track `heldButtons` for lease cleanup, so
 *  derive the mask from it rather than trusting a field the viewer omits. */
const MOUSE_BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4 };

function heldButtonsMask(st: ControllerState): number {
  let mask = 0;
  for (const b of st.heldButtons) mask |= MOUSE_BUTTON_BITS[b] ?? 0;
  return mask;
}

/** Dispatch one viewer input event onto the page. Coordinates arrive in remote
 *  CSS-viewport space (the viewer maps from its canvas), which is exactly what
 *  Input.* expects — no scaling here on purpose. */
function dispatchInput(p: CastProducer, msg: Record<string, any>, st: ControllerState): void {
  const ev = msg?.event;
  if (!ev || typeof ev !== "object") return;
  if (msg.type === "mouseEvent") {
    const button = typeof ev.button === "string" ? ev.button : "none";
    if (ev.type === "mousePressed") st.heldButtons.add(button);
    if (ev.type === "mouseReleased") st.heldButtons.delete(button);
    producerSend(p, "Input.dispatchMouseEvent", {
      type: ev.type, x: Number(ev.x) || 0, y: Number(ev.y) || 0,
      button, buttons: ev.buttons !== undefined
        ? Number(ev.buttons) || 0
        : heldButtonsMask(st),
      clickCount: Number(ev.clickCount) || (ev.type === "mouseMoved" ? 0 : 1),
      modifiers: Number(ev.modifiers) || 0,
      ...(ev.deltaX !== undefined ? { deltaX: Number(ev.deltaX) || 0 } : {}),
      ...(ev.deltaY !== undefined ? { deltaY: Number(ev.deltaY) || 0 } : {}),
    });
    return;
  }
  if (msg.type === "keyEvent") {
    const code = Number(ev.windowsVirtualKeyCode) || 0;
    if (ev.type === "keyDown" && code) st.heldKeys.add(code);
    if (ev.type === "keyUp" && code) st.heldKeys.delete(code);
    producerSend(p, "Input.dispatchKeyEvent", {
      type: ev.type, key: ev.key, code: ev.code,
      text: ev.text, unmodifiedText: ev.unmodifiedText,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      modifiers: Number(ev.modifiers) || 0,
      autoRepeat: !!ev.autoRepeat, isKeypad: false, isSystemKey: false,
    });
    return;
  }
  if (msg.type === "insertText" && typeof msg.text === "string") {
    // Covers IME-committed text and paste without needing composition sync.
    producerSend(p, "Input.insertText", { text: msg.text.slice(0, 4096) });
  }
}

/** Let go of whatever the controller was holding. Without this a lease that ends
 *  mid-drag leaves the page with a stuck button and a pressed modifier. */
function releaseHeldInput(p: CastProducer, st: ControllerState): void {
  for (const button of st.heldButtons) {
    producerSend(p, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: 0, y: 0, button, buttons: 0, clickCount: 1,
    });
  }
  st.heldButtons.clear();
  for (const code of st.heldKeys) {
    producerSend(p, "Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
  }
  st.heldKeys.clear();
}

/** Attach a viewer socket to this target's stream, starting the producer if needed. */
export async function attachCastViewer(
  sessionId: string, targetId: string, viewer: WebSocket, leaseId?: string
): Promise<void> {
  if (cdpServiceOverrides.attachCastViewer) {
    return cdpServiceOverrides.attachCastViewer(sessionId, targetId, viewer, leaseId);
  }
  const key = targetKey(sessionId, targetId);
  // Track disconnects that happen *while* we're still setting the producer up.
  let gone = viewer.readyState !== WebSocket.OPEN;
  const markGone = () => { gone = true; };
  viewer.once("close", markGone);
  viewer.once("error", markGone);

  let p = producers.get(key);
  if (!p || p.closed || p.socket.readyState !== WebSocket.OPEN) {
    let pending = producersStarting.get(key);
    if (!pending) {
      pending = assertPageTarget(sessionId, targetId)
        .then(() => createProducer(sessionId, targetId))
        .finally(() => {
        if (producersStarting.get(key) === pending) producersStarting.delete(key);
      });
      producersStarting.set(key, pending);
    }
    p = await pending;
  }
  if (p.stopTimer) { clearTimeout(p.stopTimer); p.stopTimer = null; }
  const producer = p;
  // Creating a producer can take seconds (socket + Chrome). A viewer that hung
  // up in the meantime must not be added to the set: its 'close' already fired,
  // so nothing would ever remove it and viewers.size would never reach zero —
  // the producer would ack frames forever and never linger out.
  if (viewer.readyState !== WebSocket.OPEN || gone) {
    scheduleLingerIfIdle(producer, key, targetId);
    return;
  }
  producer.viewers.add(viewer);
  // A viewer that joins while masked must be told so — otherwise it just sees a
  // frozen (or blank) picture with no explanation.
  if (producer.masked) {
    viewer.send(JSON.stringify({ type: "masked", masked: true }));
  } else if (producer.lastFrame && !producer.pendingLayout) {
    // Paint something immediately instead of waiting for the next frame.
    viewer.send(JSON.stringify({
      data: producer.lastFrame.data, url: producer.url, title: producer.title, favicon: null,
      revision: producer.lastFrame.revision,
      layoutWidth: producer.lastFrame.width,
      layoutHeight: producer.lastFrame.height,
    }));
  }
  // Input is accepted only from a connection that carries a live lease. Viewers
  // without one are strictly observers: their messages are dropped, not merely
  // ignored by the UI. (Before this, any cast connection would have become a
  // control channel the moment the producer started reading input.)
  if (leaseId) {
    const state: ControllerState = { heldButtons: new Set(), heldKeys: new Set(), leaseId };
    producer.controllers.set(viewer, state);
    viewer.on("message", (raw: WebSocket.RawData) => {
      if (producer.closed) return;
      let msg: Record<string, any>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // revision is mandatory: making it optional means "omit it and skip the
      // check", which is not a check at all.
      if (!Number.isInteger(msg?.revision)) return;
      // Serialise: each event's lease lookup is an independent await, and letting
      // them race means press/move/release can reach the page out of order (a
      // release arriving before its press leaves the button stuck down).
      producer.inputChain = producer.inputChain.then(async () => {
        if (producer.closed || !producer.controllers.has(viewer)) return;
        // Re-checked *after* the await as well: the layout can change while the
        // lease query is in flight, and coordinates computed against the old one
        // would then land somewhere else. Mid-reconfigure, refuse outright.
        if (producer.pendingLayout) return;
        if (msg.revision !== producer.viewportRevision) return;
        const ok = await holdsLease(sessionId, targetId, leaseId);
        if (!ok || producer.closed || producer.pendingLayout) return;
        if (msg.revision !== producer.viewportRevision) return;
        dispatchInput(producer, msg, state);
      }).catch(() => { /* arbitration unavailable: refuse the input */ });
    });
    // Release only what *this* connection is holding. Clearing producer-wide
    // state here would let a stale socket's close interrupt the current holder.
    viewer.once("close", () => {
      producer.controllers.delete(viewer);
      releaseHeldInput(producer, state);
    });
  }

  const detach = () => {
    producer.viewers.delete(viewer);
    if (producer.viewers.size > 0 || producer.closed) return;
    // 'close' and 'error' can both fire for the same viewer: without clearing,
    // the second call leaves an orphan timer that fires against a producer that
    // has already been stopped (and possibly replaced).
    scheduleLingerIfIdle(producer, key, targetId);
  };
  viewer.on("close", detach);
  viewer.on("error", detach);
}

/** Re-assert the viewport on the producer's own session and restart the stream
 *  so subsequent frames are rendered at the new size. */
export async function applyViewportToProducer(sessionId: string, targetId: string): Promise<boolean> {
  const p = producers.get(targetKey(sessionId, targetId));
  const want = targetViewports.get(targetKey(sessionId, targetId));
  if (!p || p.closed || !want) return false;
  const layoutNow = layoutSize(want);
  beginReconfigure(p, layoutNow.width, layoutNow.height);
  producerSend(p, "Emulation.setDeviceMetricsOverride", {
    width: layoutNow.width, height: layoutNow.height, deviceScaleFactor: want.deviceScaleFactor,
    mobile: false, screenWidth: layoutNow.width, screenHeight: layoutNow.height,
    dontSetVisibleSize: false,
  });
  producerSend(p, "Page.stopScreencast");
  producerSend(p, "Page.setWebLifecycleState", { state: "active" });
  startCast(p, want, layoutNow);
  setTimeout(() => {
    if (!p.closed) fitViewportToContent(p, sessionId, targetId, want).catch(() => {});
  }, 800);
  return true;
}

export function cleanupCdpSession(sessionId: string): void {
  if (cdpServiceOverrides.cleanupCdpSession) {
    return cdpServiceOverrides.cleanupCdpSession(sessionId);
  }
  const ws = activeSessions.get(sessionId);
  if (ws) {
    ws.terminate();
    activeSessions.delete(sessionId);
  }
  sessionUserAgents.delete(sessionId);
  forgetTargetViewport(sessionId);
}

export async function executeCdpCommand(
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
  targetId?: string
): Promise<Record<string, unknown>> {
  if (cdpServiceOverrides.executeCdpCommand) {
    return cdpServiceOverrides.executeCdpCommand(sessionId, method, params, targetId);
  }

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
