// Engine-agnostic contract for managing per-session browser workloads.
// DockerDriver runs each session as a Docker container (compose deployments);
// KubernetesDriver runs each session as a Pod + per-session Service + PVC.

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
export function buildBrowserEnv(domainHost: string): Record<string, string> {
  return {
    DOMAIN: `${domainHost}:3000`,
    CDP_DOMAIN: `${domainHost}:9223`,
    LOG_STORAGE_ENABLED: "false",
    DISABLE_CHROME_SANDBOX: "true",
    CHROME_HEADLESS: "false",
    // Passkey override is applied via CDP Page.addScriptToEvaluateOnNewDocument
    // after the workload starts (see cdp.service.ts). The --load-extension flag
    // is intentionally omitted: the Steel Browser image includes --disable-extensions
    // which silently prevents any user-loaded extension from running.
    // --disable-blink-features=AutomationControlled removes the Blink-level
    // AutomationControlled feature flag that Chrome sets when launched via CDP.
    // Without this, navigator.webdriver is true at the C++ layer even if the
    // JS getter is patched, and some fingerprint scripts probe deeper than JS.
    CHROME_ARGS:
      "--disable-blink-features=AutomationControlled --disable-features=FedCm,WebAuthnConditionalUI --password-store=basic --use-mock-keychain --use-gl=angle --use-angle=swiftshader",
  };
}

// Xvnc (TigerVNC) is both the X server and the VNC server: unlike the old
// Xvfb + x0vncserver pair it accepts the RFB SetDesktopSize request, so the
// noVNC viewer can resize the remote resolution to match the viewer window.
export const BROWSER_STARTUP_COMMAND =
  "nohup Xvnc :10 -geometry 1920x1080 -depth 24 -SecurityTypes None -rfbport 5900 -AlwaysShared -AcceptSetDesktopSize >/tmp/xvnc.log 2>&1 & sleep 2 && " +
  "nohup websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 & " +
  "exec /app/api/entrypoint.sh";
