import Docker from "dockerode";
import { config } from "../config.js";
import { prisma } from "../db/client.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const CONTAINER_PREFIX = "browsermint-session-";
const MANAGED_LABEL = "browsermint.managed";
const SESSION_LABEL = "browsermint.session";
const HEALTH_POLL_INTERVAL_MS = 2000;
const HEALTH_POLL_TIMEOUT_MS = 60000;

export interface ContainerInfo {
  containerId: string;
  containerName: string;
  internalApiUrl: string;
}

export type SessionRecoveredCallback = (sessionId: string, internalApiUrl: string) => void;

const MAX_AUTO_RESTART = 3;

type DockerServiceOverrides = Partial<{
  createAndStartContainer: (sessionId: string) => Promise<ContainerInfo>;
  waitForContainerReady: (internalApiUrl: string) => Promise<void>;
  stopContainer: (containerId: string) => Promise<void>;
  startExistingContainer: (containerId: string) => Promise<ContainerInfo>;
  stopAndRemoveContainer: (containerId: string) => Promise<void>;
  listContainers: () => Promise<Docker.ContainerInfo[]>;
  setContainerClipboard: (containerId: string, text: string) => Promise<void>;
  pauseContainer: (containerId: string) => Promise<void>;
  unpauseContainer: (containerId: string) => Promise<void>;
}>;

let dockerServiceOverrides: DockerServiceOverrides = {};

export function setDockerServiceOverridesForTests(overrides: DockerServiceOverrides): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setDockerServiceOverridesForTests can only be used when NODE_ENV=test");
  }
  dockerServiceOverrides = overrides;
}

export function resetDockerServiceOverridesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetDockerServiceOverridesForTests can only be used when NODE_ENV=test");
  }
  dockerServiceOverrides = {};
}

export async function createAndStartContainer(
  sessionId: string
): Promise<ContainerInfo> {
  if (dockerServiceOverrides.createAndStartContainer) {
    return dockerServiceOverrides.createAndStartContainer(sessionId);
  }
  const containerName = `${CONTAINER_PREFIX}${sessionId}`;

  console.info(`[docker] Creating container ${containerName}`);
  const container = await docker.createContainer({
    name: containerName,
    Image: config.STEEL_BROWSER_IMAGE,
    Labels: {
      [MANAGED_LABEL]: "true",
      [SESSION_LABEL]: sessionId,
    },
    Env: [
      `DOMAIN=${containerName}:3000`,
      `CDP_DOMAIN=${containerName}:9223`,
      "LOG_STORAGE_ENABLED=false",
      "DISABLE_CHROME_SANDBOX=true",
      "CHROME_HEADLESS=false",
      // Passkey override is applied via CDP Page.addScriptToEvaluateOnNewDocument
      // after the container starts (see cdp.service.ts). The --load-extension flag
      // is intentionally omitted: the Steel Browser image includes --disable-extensions
      // which silently prevents any user-loaded extension from running.
      // --disable-blink-features=AutomationControlled removes the Blink-level
      // AutomationControlled feature flag that Chrome sets when launched via CDP.
      // Without this, navigator.webdriver is true at the C++ layer even if the
      // JS getter is patched, and some fingerprint scripts probe deeper than JS.
      "CHROME_ARGS=--disable-blink-features=AutomationControlled --disable-features=FedCm,WebAuthnConditionalUI --password-store=basic --use-mock-keychain --use-gl=angle --use-angle=swiftshader",
    ],
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [
      "nohup Xvfb :10 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 & sleep 2 && " +
      "nohup x0vncserver -display :10 -SecurityTypes None -rfbport 5900 -Log *:stderr:0 >/tmp/x0vnc.log 2>&1 & " +
      "sleep 1 && nohup websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 & " +
      "exec /app/api/entrypoint.sh",
    ],
    HostConfig: {
      NetworkMode: config.DOCKER_NETWORK_NAME,
      // Phase 2: Memory: 2 * 1024 * 1024 * 1024, NanoCpus: 2e9
    },
  });

  console.info(`[docker] Container ${containerName} created (ID: ${container.id.slice(0, 12)}), starting...`);
  await container.start();

  // Container name DNS only resolves inside Docker networks.
  // When the backend runs on the host, inspect the container to get its
  // actual IP on the internal network — reachable from both host and Docker.
  const info = await container.inspect();
  const networkInfo = info.NetworkSettings.Networks[config.DOCKER_NETWORK_NAME];
  if (!networkInfo?.IPAddress) {
    await container.remove({ force: true }).catch(() => {});
    throw new Error(`Container did not get an IP on network ${config.DOCKER_NETWORK_NAME}`);
  }
  const internalApiUrl = `http://${networkInfo.IPAddress}:3000`;

  console.info(`[docker] Container ${containerName} started (IP: ${networkInfo.IPAddress})`);
  return {
    containerId: container.id,
    containerName,
    internalApiUrl,
  };
}

export async function waitForContainerReady(
  internalApiUrl: string
): Promise<void> {
  if (dockerServiceOverrides.waitForContainerReady) {
    return dockerServiceOverrides.waitForContainerReady(internalApiUrl);
  }
  const healthUrl = `${internalApiUrl}/v1/health`;
  const startTime = Date.now();

  console.info(`[docker] Waiting for Steel Browser API to be ready at ${internalApiUrl}...`);
  while (Date.now() - startTime < HEALTH_POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.info(`[docker] Steel Browser API ready at ${internalApiUrl} (${Date.now() - startTime}ms)`);
        return;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTFOUND / ECONNREFUSED are expected during startup
      if (code !== "ENOTFOUND" && code !== "ECONNREFUSED" && code !== "UND_ERR_CONNECT_TIMEOUT") {
        // Other errors: still wait, container may still be starting
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Container at ${internalApiUrl} did not become ready within ${HEALTH_POLL_TIMEOUT_MS}ms`);
}

// Stop-only: preserves the container filesystem so data survives across stop/start.
// Use this for the Stop action. Use stopAndRemoveContainer for Delete.
export async function stopContainer(containerId: string): Promise<void> {
  if (dockerServiceOverrides.stopContainer) {
    return dockerServiceOverrides.stopContainer(containerId);
  }
  console.info(`[docker] Stopping container ${containerId.slice(0, 12)}`);
  try {
    const container = docker.getContainer(containerId);
    await container.stop({ t: 5 });
    console.info(`[docker] Container ${containerId.slice(0, 12)} stopped`);
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 304 || statusCode === 404) {
      // 304: already stopped, 404: already gone — both are fine
      console.info(`[docker] Container ${containerId.slice(0, 12)} already ${statusCode === 404 ? "gone" : "stopped"}`);
      return;
    }
    throw err;
  }
}

export async function pauseContainer(containerId: string): Promise<void> {
  if (dockerServiceOverrides.pauseContainer) {
    return dockerServiceOverrides.pauseContainer(containerId);
  }
  console.info(`[docker] Pausing container ${containerId.slice(0, 12)}`);
  try {
    await docker.getContainer(containerId).pause();
    console.info(`[docker] Container ${containerId.slice(0, 12)} paused`);
  } catch (err: unknown) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 409 || code === 404) return; // already paused or gone — idempotent
    throw err;
  }
}

export async function unpauseContainer(containerId: string): Promise<void> {
  if (dockerServiceOverrides.unpauseContainer) {
    return dockerServiceOverrides.unpauseContainer(containerId);
  }
  console.info(`[docker] Unpausing container ${containerId.slice(0, 12)}`);
  try {
    await docker.getContainer(containerId).unpause();
    console.info(`[docker] Container ${containerId.slice(0, 12)} unpaused`);
  } catch (err: unknown) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 409) return; // already running — idempotent
    if (code === 404) throw new Error(`Container ${containerId.slice(0, 12)} not found during unpause`);
    throw err;
  }
}

function isNetworkNotFoundError(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return /network\b.*\bnot found/i.test(msg) || /failed to set up container networking/i.test(msg);
}

async function reconnectContainerNetwork(containerId: string): Promise<void> {
  // When docker compose down+up recreates the network under the same name, the old
  // NetworkID embedded in the container config is stale. Docker treats a connect() call
  // as an upsert: if a stale endpoint exists it replaces it; if already current it
  // returns 409 which we ignore. No explicit disconnect needed.
  try {
    await docker.getNetwork(config.DOCKER_NETWORK_NAME).connect({ Container: containerId });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err;
  }
}

// Start an existing (stopped) container and return its updated network info.
// The container's filesystem (Chrome user data, cookies, etc.) is preserved.
export async function startExistingContainer(
  containerId: string
): Promise<ContainerInfo> {
  if (dockerServiceOverrides.startExistingContainer) {
    return dockerServiceOverrides.startExistingContainer(containerId);
  }
  console.info(`[docker] Starting existing container ${containerId.slice(0, 12)}`);
  const container = docker.getContainer(containerId);
  try {
    await container.start();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    // 304: container is already running (e.g., backend crashed mid-init) — that's fine
    if (statusCode === 304) {
      console.info(`[docker] Container ${containerId.slice(0, 12)} was already running`);
    } else if (isNetworkNotFoundError(err)) {
      // docker compose down deletes managed networks; containers still reference the old
      // network ID and cannot start. Reconnect to the current network and retry.
      console.warn(
        `[docker] Container ${containerId.slice(0, 12)}: network not found, reconnecting to ${config.DOCKER_NETWORK_NAME}`
      );
      await reconnectContainerNetwork(containerId);
      await container.start();
      console.info(`[docker] Container ${containerId.slice(0, 12)} started after network reconnect`);
    } else {
      throw err;
    }
  }

  // Xvfb fails to start on container restart because /tmp/.X10-lock is left behind
  // from the previous run. Its PID collides with the new Xvfb process (both get the
  // same PID in the container's fresh PID namespace). Xvfb reads the lock, sees its
  // own PID as "already running", and exits. Chrome then has no display and crashes.
  //
  // Fix: kill stale Xvfb, remove lock files, restart Xvfb fresh. Chrome is safe to
  // do this before because it is started by the Node.js API ~2s after container boot
  // (the entrypoint sleeps 2 seconds before launching the API, which then starts Chrome).
  try {
    console.info(`[docker] Clearing stale Xvfb lock and restarting display for container ${containerId.slice(0, 12)}`);
    const exec = await container.exec({
      Cmd: [
        "sh", "-c",
        "pkill -x Xvfb 2>/dev/null || true; " +
        "rm -f /tmp/.X10-lock /tmp/.X11-unix/X10; " +
        "nohup Xvfb :10 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 & " +
        "sleep 1; " +
        "pkill -f x0vncserver 2>/dev/null || true; " +
        "nohup x0vncserver -display :10 -SecurityTypes None -rfbport 5900 -Log *:stderr:0 >/tmp/x0vnc.log 2>&1 & " +
        "pkill -f 'websockify 6080' 2>/dev/null || true; " +
        "nohup websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 &",
      ],
      AttachStdout: false,
      AttachStderr: false,
    });
    await exec.start({ Detach: true });
    // Brief pause so Xvfb is ready before Chrome starts (which happens ~2s after boot)
    await new Promise((r) => setTimeout(r, 500));
    console.info(`[docker] Xvfb restarted for container ${containerId.slice(0, 12)}`);
  } catch (err) {
    console.warn(`[docker] Failed to restart Xvfb for container ${containerId.slice(0, 12)}:`, (err as Error).message);
  }

  const info = await container.inspect();
  const networkInfo = info.NetworkSettings.Networks[config.DOCKER_NETWORK_NAME];
  if (!networkInfo?.IPAddress) {
    throw new Error(`Container did not get an IP on network ${config.DOCKER_NETWORK_NAME}`);
  }

  console.info(`[docker] Container ${containerId.slice(0, 12)} started (IP: ${networkInfo.IPAddress})`);
  return {
    containerId: container.id,
    containerName: info.Name.replace(/^\//, ""),
    internalApiUrl: `http://${networkInfo.IPAddress}:3000`,
  };
}

export async function stopAndRemoveContainer(
  containerId: string
): Promise<void> {
  if (dockerServiceOverrides.stopAndRemoveContainer) {
    return dockerServiceOverrides.stopAndRemoveContainer(containerId);
  }
  console.info(`[docker] Stopping and removing container ${containerId.slice(0, 12)}`);
  try {
    const container = docker.getContainer(containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    console.info(`[docker] Container ${containerId.slice(0, 12)} removed`);
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404) {
      console.info(`[docker] Container ${containerId.slice(0, 12)} already gone`);
      return;
    }
    throw err;
  }
}

let reconcileRunning = false;

export async function reconcileContainers(
  startup = false,
  onSessionRecovered?: SessionRecoveredCallback
): Promise<void> {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    await _reconcileContainers(startup, onSessionRecovered);
  } finally {
    reconcileRunning = false;
  }
}

async function _reconcileContainers(
  startup: boolean,
  onSessionRecovered: SessionRecoveredCallback | undefined
): Promise<void> {
  let managedContainers: Docker.ContainerInfo[] = [];
  try {
    managedContainers = dockerServiceOverrides.listContainers
      ? await dockerServiceOverrides.listContainers()
      : await docker.listContainers({
          all: true,
          filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
        });
  } catch (err) {
    console.error("[reconcile] Failed to list Docker containers:", err);
    return;
  }

  // Containers that exist in Docker but not in DB → remove
  for (const c of managedContainers) {
    const sessionId = c.Labels?.[SESSION_LABEL];
    if (!sessionId) continue;

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.deletedAt) {
      console.info(`[reconcile] Removing orphan container ${c.Id.slice(0, 12)} (session ${sessionId} not in DB)`);
      await stopAndRemoveContainer(c.Id).catch((err) =>
        console.error(`[reconcile] Failed to remove orphan container ${c.Id.slice(0, 12)}:`, err)
      );
    }
  }

  const containerById = new Map(managedContainers.map((c) => [c.Id, c]));

  // DB sessions with status=running/creating but container missing or not running → mark error
  const activeSessions = await prisma.session.findMany({
    where: { status: { in: ["running", "creating"] }, deletedAt: null },
  });

  for (const session of activeSessions) {
    const container = session.containerId ? containerById.get(session.containerId) : undefined;

    if (!container) {
      console.info(`[reconcile] Session ${session.id}: container not found — marking error`);
      const delta = session.runningStartedAt
        ? Math.max(0, Date.now() - session.runningStartedAt.getTime()) : 0;
      await prisma.session.update({
        where: { id: session.id },
        data: { status: "error", onlineMs: { increment: delta }, runningStartedAt: null },
      });
    } else if (container.State === "paused") {
      // Backend crashed after docker pause but before updating DB — correct DB to "paused"
      console.info(`[reconcile] Session ${session.id}: container paused but DB says running — correcting to "paused"`);
      const delta = session.runningStartedAt
        ? Math.max(0, Date.now() - session.runningStartedAt.getTime()) : 0;
      await prisma.session.update({
        where: { id: session.id },
        data: { status: "paused", onlineMs: { increment: delta }, runningStartedAt: null },
      });
    } else if (container.State !== "running") {
      const isExited = container.State === "exited";
      const canRetry = isExited && session.autoRestartAttempts < MAX_AUTO_RESTART;

      if (canRetry) {
        console.info(
          `[reconcile] Session ${session.id}: container exited — attempting auto-restart ` +
          `(attempt ${session.autoRestartAttempts + 1}/${MAX_AUTO_RESTART})`
        );
        try {
          const containerInfo = await startExistingContainer(session.containerId!);
          await prisma.session.update({
            where: { id: session.id },
            data: {
              autoRestartAttempts: 0,
              internalApiUrl: containerInfo.internalApiUrl,
              runningStartedAt: new Date(Date.now()),
            },
          });
          console.info(`[reconcile] Session ${session.id}: auto-restart succeeded`);
          onSessionRecovered?.(session.id, containerInfo.internalApiUrl);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404) {
            console.warn(`[reconcile] Session ${session.id}: container gone (404) — marking error`);
            const delta = session.runningStartedAt
              ? Math.max(0, Date.now() - session.runningStartedAt.getTime()) : 0;
            await prisma.session.update({
              where: { id: session.id },
              data: { status: "error", onlineMs: { increment: delta }, runningStartedAt: null },
            });
          } else {
            console.warn(
              `[reconcile] Session ${session.id}: auto-restart failed ` +
              `(attempt ${session.autoRestartAttempts + 1}):`,
              (err as Error).message
            );
            await prisma.session.update({
              where: { id: session.id },
              data: { autoRestartAttempts: { increment: 1 } },
            });
          }
        }
      } else {
        const reason = !isExited
          ? `container state is "${container.State}"`
          : `auto-restart limit reached (${session.autoRestartAttempts}/${MAX_AUTO_RESTART})`;
        console.info(`[reconcile] Session ${session.id}: ${reason} — marking error`);
        const delta = session.runningStartedAt
          ? Math.max(0, Date.now() - session.runningStartedAt.getTime()) : 0;
        await prisma.session.update({
          where: { id: session.id },
          data: { status: "error", onlineMs: { increment: delta }, runningStartedAt: null },
        });
      }
    } else if (session.status === "creating" && startup) {
      // Container is running but session is stuck in "creating" (backend crashed mid-init).
      // Only fix this on startup — during normal operation handleStartSession may still be
      // actively initializing the session (can take 90+ seconds), so we must not interfere.
      console.info(`[reconcile] Session ${session.id}: stuck in "creating" since last startup — marking error`);
      await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
    }
  }

  // Fix stuck "stopping" sessions — backend crashed before completing the stop
  const stoppingSessions = await prisma.session.findMany({
    where: { status: "stopping", deletedAt: null },
  });

  for (const session of stoppingSessions) {
    console.info(`[reconcile] Session ${session.id}: stuck in "stopping" — completing stop`);
    if (session.containerId) {
      await stopContainer(session.containerId).catch(() => {});
    }
    const delta = session.runningStartedAt
      ? Math.max(0, Date.now() - session.runningStartedAt.getTime()) : 0;
    await prisma.session.update({
      where: { id: session.id },
      data: { status: "stopped", onlineMs: { increment: delta }, runningStartedAt: null },
    });
  }

  // Handle sessions whose DB status is "paused" — verify container state matches
  const pausedDbSessions = await prisma.session.findMany({
    where: { status: "paused", deletedAt: null },
  });

  for (const session of pausedDbSessions) {
    const container = session.containerId ? containerById.get(session.containerId) : undefined;

    if (!container) {
      console.info(`[reconcile] Session ${session.id}: paused but container missing — marking error`);
      await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
    } else if (container.State === "paused") {
      // Healthy: DB paused + Docker paused — nothing to do
    } else if (container.State === "running") {
      // Backend crashed after unpause but before updating DB — correct DB to "running"
      console.info(`[reconcile] Session ${session.id}: container running but DB says paused — correcting to "running"`);
      await prisma.session.update({
        where: { id: session.id },
        data: { status: "running", runningStartedAt: new Date(Date.now()) },
      });
    } else {
      const isExited = container.State === "exited";
      const canRetry = isExited && session.autoRestartAttempts < MAX_AUTO_RESTART;

      if (canRetry) {
        console.info(
          `[reconcile] Session ${session.id}: paused container exited — attempting auto-restart ` +
          `(attempt ${session.autoRestartAttempts + 1}/${MAX_AUTO_RESTART})`
        );
        try {
          const containerInfo = await startExistingContainer(session.containerId!);
          await prisma.session.update({
            where: { id: session.id },
            data: {
              status: "running",
              autoRestartAttempts: 0,
              internalApiUrl: containerInfo.internalApiUrl,
              runningStartedAt: new Date(Date.now()),
            },
          });
          console.info(`[reconcile] Session ${session.id}: auto-restart from paused succeeded`);
          onSessionRecovered?.(session.id, containerInfo.internalApiUrl);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404) {
            await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
          } else {
            await prisma.session.update({
              where: { id: session.id },
              data: { autoRestartAttempts: { increment: 1 } },
            });
          }
        }
      } else {
        const reason = !isExited
          ? `container state is "${container.State}"`
          : `auto-restart limit reached (${session.autoRestartAttempts}/${MAX_AUTO_RESTART})`;
        console.info(`[reconcile] Session ${session.id}: paused — ${reason} — marking error`);
        await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
      }
    }
  }

  // Clean up running containers left behind by failed create/start operations.
  // These sessions are in "error" state but their container was started before the failure.
  const errorSessionsWithContainer = await prisma.session.findMany({
    where: { status: "error", deletedAt: null, containerId: { not: null } },
  });

  for (const session of errorSessionsWithContainer) {
    const container = session.containerId ? containerById.get(session.containerId) : undefined;
    if (container && container.State === "running") {
      console.info(`[reconcile] Session ${session.id}: error status but container still running — removing`);
      await stopAndRemoveContainer(session.containerId!).catch((err) =>
        console.error(`[reconcile] Failed to remove container for error session ${session.id}:`, err)
      );
      await prisma.session.update({
        where: { id: session.id },
        data: { containerId: null, containerName: null, internalApiUrl: null },
      });
    } else if (container && container.State === "exited" && session.autoRestartAttempts < MAX_AUTO_RESTART) {
      // Existing error session whose container exited (e.g. host rebooted while backend ran old code).
      // Attempt auto-restart so the session self-heals without user intervention.
      console.info(
        `[reconcile] Session ${session.id}: error status with exited container — attempting auto-restart ` +
        `(attempt ${session.autoRestartAttempts + 1}/${MAX_AUTO_RESTART})`
      );
      try {
        const containerInfo = await startExistingContainer(session.containerId!);
        await prisma.session.update({
          where: { id: session.id },
          data: {
            status: "running",
            autoRestartAttempts: 0,
            internalApiUrl: containerInfo.internalApiUrl,
            runningStartedAt: new Date(Date.now()),
          },
        });
        console.info(`[reconcile] Session ${session.id}: auto-restart from error succeeded`);
        onSessionRecovered?.(session.id, containerInfo.internalApiUrl);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404) {
          console.warn(`[reconcile] Session ${session.id}: container gone (404) during error auto-restart — clearing metadata`);
          await prisma.session.update({
            where: { id: session.id },
            data: { containerId: null, containerName: null, internalApiUrl: null },
          });
        } else {
          console.warn(
            `[reconcile] Session ${session.id}: error auto-restart failed (attempt ${session.autoRestartAttempts + 1}):`,
            (err as Error).message
          );
          await prisma.session.update({
            where: { id: session.id },
            data: { autoRestartAttempts: { increment: 1 } },
          });
        }
      }
    }
  }
}

// Set the X11 CLIPBOARD selection inside the container via xclip.
// This is the reliable way to paste text into Chrome running in the container —
// ClientCutText (VNC clipboard) only sets PRIMARY, which Chrome's Ctrl+V ignores.
export async function setContainerClipboard(containerId: string, text: string): Promise<void> {
  if (dockerServiceOverrides.setContainerClipboard) {
    return dockerServiceOverrides.setContainerClipboard(containerId, text);
  }
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["sh", "-c", "cat | DISPLAY=:10 xclip -selection clipboard -i"],
    AttachStdin: true,
    AttachStdout: false,
    AttachStderr: false,
  });
  await new Promise<void>((resolve, reject) => {
    exec.start({ hijack: true, stdin: true }, (err: Error | null, stream: NodeJS.ReadWriteStream | undefined) => {
      if (err) return reject(err);
      if (!stream) return reject(new Error("No exec stream"));
      stream.write(Buffer.from(text, "utf-8"));
      stream.end();
      // Give xclip a moment to process before the caller sends Ctrl+V
      setTimeout(resolve, 80);
    });
  });
}

export async function pullImageIfNeeded(): Promise<void> {
  // If the image already exists locally (e.g. a locally-built image like browsermint-browser:latest),
  // skip the pull entirely — docker.pull would fail with 404 for images not on Docker Hub.
  try {
    await docker.getImage(config.STEEL_BROWSER_IMAGE).inspect();
    console.info(`[docker] Image ${config.STEEL_BROWSER_IMAGE} already present locally, skipping pull`);
    return;
  } catch {
    // Image not found locally — proceed with pull
  }

  return new Promise((resolve) => {
    docker.pull(config.STEEL_BROWSER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        console.warn("[docker] Image pull failed (non-fatal):", err.message);
        return resolve();
      }
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) {
          console.warn("[docker] Image pull error:", err.message);
        }
        resolve();
      });
    });
  });
}
