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

export async function createAndStartContainer(
  sessionId: string
): Promise<ContainerInfo> {
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

// Start an existing (stopped) container and return its updated network info.
// The container's filesystem (Chrome user data, cookies, etc.) is preserved.
export async function startExistingContainer(
  containerId: string
): Promise<ContainerInfo> {
  console.info(`[docker] Starting existing container ${containerId.slice(0, 12)}`);
  const container = docker.getContainer(containerId);
  try {
    await container.start();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    // 304: container is already running (e.g., backend crashed mid-init) — that's fine
    if (statusCode !== 304) throw err;
    console.info(`[docker] Container ${containerId.slice(0, 12)} was already running`);
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

export async function reconcileContainers(startup = false): Promise<void> {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    await _reconcileContainers(startup);
  } finally {
    reconcileRunning = false;
  }
}

async function _reconcileContainers(startup: boolean): Promise<void> {
  let managedContainers: Docker.ContainerInfo[] = [];
  try {
    managedContainers = await docker.listContainers({
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
      await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
    } else if (container.State === "paused") {
      // Backend crashed after docker pause but before updating DB — correct DB to "paused"
      console.info(`[reconcile] Session ${session.id}: container paused but DB says running — correcting to "paused"`);
      await prisma.session.update({ where: { id: session.id }, data: { status: "paused" } });
    } else if (container.State !== "running") {
      // Container exists but stopped/crashed — user can retry resume
      console.info(`[reconcile] Session ${session.id}: container state is "${container.State}" — marking error`);
      await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
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
    await prisma.session.update({ where: { id: session.id }, data: { status: "stopped" } });
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
      await prisma.session.update({ where: { id: session.id }, data: { status: "running" } });
    } else {
      console.info(`[reconcile] Session ${session.id}: paused but container state "${container.State}" — marking error`);
      await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
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
    }
  }
}

// Set the X11 CLIPBOARD selection inside the container via xclip.
// This is the reliable way to paste text into Chrome running in the container —
// ClientCutText (VNC clipboard) only sets PRIMARY, which Chrome's Ctrl+V ignores.
export async function setContainerClipboard(containerId: string, text: string): Promise<void> {
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
