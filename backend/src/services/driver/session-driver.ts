// Engine-agnostic contract for managing per-session browser workloads.
// DockerDriver runs each session as a Docker container (compose deployments);
// KubernetesDriver runs each session as a Pod + per-session Service + PVC.
import { config } from "../../config.js";

export interface SessionEndpoint {
  // Docker: container id. Kubernetes: pod name.
  containerId: string;
  // Docker: container name. Kubernetes: pod name.
  containerName: string;
  // Base URL of the Steel API inside the workload (port 3000). CDP (9223) and
  // VNC websockify (6080) URLs are derived from it by swapping the port.
  internalApiUrl: string;
}

export type ManagedWorkloadState =
  | "running"
  | "paused"
  | "exited"
  // Workload is still coming up (scheduling, image pull, not yet ready).
  // Reconcile must leave it alone.
  | "starting"
  // Any state reconcile cannot recover from (docker "dead"/"created", etc.).
  | "unknown";

export interface ManagedWorkload {
  // Opaque reference usable as the `ref` argument of driver methods.
  ref: string;
  sessionId: string;
  state: ManagedWorkloadState;
}

// Raised when the referenced workload no longer exists in the engine.
export class WorkloadGoneError extends Error {
  constructor(message = "Workload not found") {
    super(message);
    this.name = "WorkloadGoneError";
  }
}

export interface SessionDriver {
  // True when pausing releases the workload entirely (K8s deletes the pod), so
  // reconcile must treat "paused session with no workload" as healthy and the
  // caller must save/restore tabs around pause/resume.
  readonly pauseReleasesWorkload: boolean;
  // Upper bound a caller should wait for a concurrent resume to finish.
  readonly resumeTimeoutMs: number;

  createSession(sessionId: string): Promise<SessionEndpoint>;
  startSession(sessionId: string, ref: string): Promise<SessionEndpoint>;
  stopSession(sessionId: string, ref: string): Promise<void>;
  destroySession(sessionId: string, ref: string | null): Promise<void>;
  pauseSession(sessionId: string, ref: string): Promise<void>;
  resumeSession(sessionId: string, ref: string): Promise<SessionEndpoint>;
  waitForReady(internalApiUrl: string): Promise<void>;
  setClipboard(sessionId: string, ref: string, text: string): Promise<void>;
  // Resize the workload's X screen (see buildResizeDisplayCommand).
  resizeDisplay(sessionId: string, ref: string, width: number, height: number): Promise<void>;
  listManagedWorkloads(): Promise<ManagedWorkload[]>;
  prepareImages(): Promise<void>;
  // Optional: remove engine resources (Services/PVCs) whose session id is not
  // in activeSessionIds. Only meaningful for drivers with auxiliary resources.
  sweepOrphanResources?(activeSessionIds: string[]): Promise<void>;
}

export const MANAGED_LABEL = "browsermint.managed";
export const SESSION_LABEL = "browsermint.session";
export const WORKLOAD_PREFIX = "browsermint-session-";

const HEALTH_POLL_INTERVAL_MS = 2000;
const HEALTH_POLL_TIMEOUT_MS = 60000;

// Shared HTTP health poll against the Steel API — engine-neutral.
export async function waitForHealth(internalApiUrl: string): Promise<void> {
  const healthUrl = `${internalApiUrl}/v1/health`;
  const startTime = Date.now();

  console.info(`[driver] Waiting for Steel Browser API to be ready at ${internalApiUrl}...`);
  while (Date.now() - startTime < HEALTH_POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.info(`[driver] Steel Browser API ready at ${internalApiUrl} (${Date.now() - startTime}ms)`);
        return;
      }
    } catch {
      // ENOTFOUND / ECONNREFUSED / timeouts are expected during startup
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Workload at ${internalApiUrl} did not become ready within ${HEALTH_POLL_TIMEOUT_MS}ms`);
}

// Env + startup command shared by both drivers so browser workloads behave
// identically regardless of engine. `domainHost` is the DNS name peers use to
// reach the workload (container name on Docker networks, Service DNS on K8s).
// The *real* device scale factor Chrome is launched with. This is the only lever
// that makes the screencast stream itself sharper: frame pixels =
// compositorSurfacePixels = layoutCss × realDsf, capped (never upscaled) by
// startScreencast's maxWidth/maxHeight.
//
// `Emulation.setDeviceMetricsOverride.deviceScaleFactor` does NOT do this —
// Blink's ScreenMetricsEmulator deliberately keeps the *real* dsf in the
// compositor ("keep the real device scale factor in compositor to produce sharp
// image even when emulating different scale factor"), so an emulated 2x reports
// devicePixelRatio 2 to the page while the captured surface stays 1x.
//
// Measured on this image (Chrome 146, 400×300 layout):
//   launch dsf 1 + emulated dsf 2, no cap        → 400×300 frames
//   launch dsf 2 + emulated dsf 1, no cap        → 800×600 frames
//   launch dsf 2 + emulated dsf 2, cap 400×300   → 400×300 frames  (cap wins)
//   launch dsf 2 + emulated dsf 2, cap 800×600   → 800×600 frames
// i.e. the page's own devicePixelRatio is irrelevant to frame resolution; the
// launch flag decides, and the cap can only scale down. Callers therefore size
// the cap by what the *viewer* can use (see castCaps in cdp.service.ts).
export const BROWSER_DEVICE_SCALE_FACTOR = 2;

export function buildBrowserEnv(domainHost: string): Record<string, string> {
  return {
    DOMAIN: `${domainHost}:3000`,
    CDP_DOMAIN: `${domainHost}:9223`,
    LOG_STORAGE_ENABLED: "false",
    DISABLE_CHROME_SANDBOX: "true",
    CHROME_HEADLESS: "false",
    // **关掉 Steel 的假指纹注入**。它本意是防指纹，实际制造了真实浏览器不可能有的
    // 自相矛盾：注入后 JS 里 navigator.userAgent 报 Chrome/139，而同一次请求的
    // HTTP User-Agent 与 sec-ch-ua 报的是二进制真实版本 146，且 userAgentData.brands
    // 被注成空数组。任何服务端把这两者一比就知道有人在改身份——比什么都不做更可疑。
    // 关掉之后三者一致（2026-08-04 实测 JS 与请求头同为 146）。
    SKIP_FINGERPRINT_INJECTION: "true",
    // 时区：见 config.ts BROWSER_TIMEZONE。容器默认 Etc/UTC 与出口地理位置不自洽。
    TZ: config.BROWSER_TIMEZONE,
    DEFAULT_TIMEZONE: config.BROWSER_TIMEZONE,
    // Passkey override is applied via CDP Page.addScriptToEvaluateOnNewDocument
    // after the workload starts (see cdp.service.ts). The --load-extension flag
    // is intentionally omitted: the Steel Browser image includes --disable-extensions
    // which silently prevents any user-loaded extension from running.
    // --disable-blink-features=AutomationControlled removes the Blink-level
    // AutomationControlled feature flag that Chrome sets when launched via CDP.
    // Without this, navigator.webdriver is true at the C++ layer even if the
    // JS getter is patched, and some fingerprint scripts probe deeper than JS.
    // --force-device-scale-factor: see BROWSER_DEVICE_SCALE_FACTOR above. A 2x
    // compositor is also what the whole Chrome UI is drawn at, which is why
    // buildResizeDisplayCommand scales the X screen to match — otherwise the
    // noVNC fallback view would lose half its usable logical space.
    CHROME_ARGS:
      "--disable-blink-features=AutomationControlled --disable-features=FedCm,WebAuthnConditionalUI " +
      "--password-store=basic --use-mock-keychain --use-gl=angle --use-angle=swiftshader " +
      `--force-device-scale-factor=${BROWSER_DEVICE_SCALE_FACTOR}`,
  };
}

// Xvnc (TigerVNC) is both the X server and the VNC server: unlike the old
// Xvfb + x0vncserver pair it accepts the RFB SetDesktopSize request, so the
// noVNC viewer can resize the remote resolution to match the viewer window.
// Resize the X screen to an arbitrary size. Xvnc exposes RandR but only knows
// the modes it was started with, so the mode is created on demand (a zero-clock
// modeline is what TigerVNC expects); both steps are idempotent-by-|| true
// because a repeated size reuses the existing mode. Callers must pass validated
// integers — the values are interpolated into a shell command.
//
// Callers pass the *logical* size they want the desktop to behave as (the noVNC
// viewer's own window size). Chrome draws its UI at BROWSER_DEVICE_SCALE_FACTOR,
// so the X screen has to be that many times larger or the desktop would only fit
// half the content it used to. The noVNC client scales the larger framebuffer
// back into its window, which also makes that view sharper. Capped at 4K so a
// maximised viewer on a big monitor cannot ask for an absurd framebuffer.
const MAX_X_SCREEN = { width: 3840, height: 2160 };
export function buildResizeDisplayCommand(width: number, height: number): string[] {
  const dsf = BROWSER_DEVICE_SCALE_FACTOR;
  const w = Math.min(Math.floor(width) * dsf, MAX_X_SCREEN.width);
  const h = Math.min(Math.floor(height) * dsf, MAX_X_SCREEN.height);
  return [
    "sh", "-c",
    `export DISPLAY=:10; ` +
    `OUT=$(xrandr | awk '/ connected/{print $1; exit}'); ` +
    `xrandr --newmode "${w}x${h}" 0 ${w} 0 0 0 ${h} 0 0 0 2>/dev/null || true; ` +
    `xrandr --addmode "$OUT" "${w}x${h}" 2>/dev/null || true; ` +
    `xrandr --output "$OUT" --mode "${w}x${h}"`,
  ];
}

// Startup geometry is in *physical* pixels, so it carries the same ×dsf factor as
// buildResizeDisplayCommand: 3840×2160 keeps the historical 1920×1080 of logical
// desktop space. Chrome will not lay a page out wider than the window it lives in,
// and the window cannot exceed the screen — so shrinking this would silently cap
// the widest viewport the cast pipeline can ask for.
export const BROWSER_STARTUP_COMMAND =
  "nohup Xvnc :10 -geometry 3840x2160 -depth 24 -SecurityTypes None -rfbport 5900 -AlwaysShared -AcceptSetDesktopSize >/tmp/xvnc.log 2>&1 & sleep 2 && " +
  "nohup websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 & " +
  "exec /app/api/entrypoint.sh";
