import Docker from "dockerode";
import { config } from "../../config.js";
import {
  type SessionDriver,
  type SessionEndpoint,
  type ManagedWorkload,
  type ManagedWorkloadState,
  WorkloadGoneError,
  MANAGED_LABEL,
  SESSION_LABEL,
  WORKLOAD_PREFIX,
  waitForHealth,
  buildBrowserEnv,
  buildResizeDisplayCommand,
  BROWSER_STARTUP_COMMAND,
} from "./session-driver.js";

function statusCodeOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

function isNetworkNotFoundError(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return /network\b.*\bnot found/i.test(msg) || /failed to set up container networking/i.test(msg);
}

function mapContainerState(state: string): ManagedWorkloadState {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "exited":
      return "exited";
    default:
      // created / restarting / removing / dead — reconcile treats these as
      // unrecoverable, matching the previous behavior.
      return "unknown";
  }
}

export class DockerDriver implements SessionDriver {
  readonly pauseReleasesWorkload = false;
  // docker unpause is near-instant; 8s covers the CDP re-init that follows.
  readonly resumeTimeoutMs = 8_000;

  private docker = new Docker({ socketPath: "/var/run/docker.sock" });

  async createSession(sessionId: string): Promise<SessionEndpoint> {
    const containerName = `${WORKLOAD_PREFIX}${sessionId}`;

    console.info(`[docker] Creating container ${containerName}`);
    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.STEEL_BROWSER_IMAGE,
      Labels: {
        [MANAGED_LABEL]: "true",
        [SESSION_LABEL]: sessionId,
      },
      Env: Object.entries(buildBrowserEnv(containerName)).map(([k, v]) => `${k}=${v}`),
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: [BROWSER_STARTUP_COMMAND],
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
    return { containerId: container.id, containerName, internalApiUrl };
  }

  // Start an existing (stopped) container and return its updated network info.
  // The container's filesystem (Chrome user data, cookies, etc.) is preserved.
  async startSession(_sessionId: string, containerId: string): Promise<SessionEndpoint> {
    console.info(`[docker] Starting existing container ${containerId.slice(0, 12)}`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.start();
    } catch (err: unknown) {
      const statusCode = statusCodeOf(err);
      // 304: container is already running (e.g., backend crashed mid-init) — that's fine
      if (statusCode === 304) {
        console.info(`[docker] Container ${containerId.slice(0, 12)} was already running`);
      } else if (statusCode === 404) {
        throw new WorkloadGoneError(`Container ${containerId.slice(0, 12)} not found`);
      } else if (isNetworkNotFoundError(err)) {
        // docker compose down deletes managed networks; containers still reference the old
        // network ID and cannot start. Reconnect to the current network and retry.
        console.warn(
          `[docker] Container ${containerId.slice(0, 12)}: network not found, reconnecting to ${config.DOCKER_NETWORK_NAME}`
        );
        await this.reconnectContainerNetwork(containerId);
        await container.start();
        console.info(`[docker] Container ${containerId.slice(0, 12)} started after network reconnect`);
      } else {
        console.warn(
          `[docker] Container ${containerId.slice(0, 12)} start failed — statusCode=${statusCode} message=${(err as Error).message}`
        );
        throw err;
      }
    }

    await this.restartDisplayStack(container, containerId);

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

  // The X server fails to start on container restart because /tmp/.X10-lock is
  // left behind from the previous run. Its PID collides with the new process
  // (both get the same PID in the container's fresh PID namespace), so Xvnc
  // reads the lock, sees its own PID as "already running", and exits. Chrome
  // then has no display and crashes.
  //
  // The container CMD is: `nohup Xvnc & sleep 2 && nohup websockify & exec api`
  // We must wait for that sequence to finish before killing anything; otherwise
  // our exec and the CMD race. After the 3.5 s wait the CMD has exec'd into the
  // API and all services are settled; we can safely restart them.
  private async restartDisplayStack(container: Docker.Container, containerId: string): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, 3500));
      console.info(`[docker] Clearing stale Xvfb lock and restarting display for container ${containerId.slice(0, 12)}`);
      const exec = await container.exec({
        Cmd: [
          "sh", "-c",
          "pkill -x Xvnc 2>/dev/null || true; " +
          "rm -f /tmp/.X10-lock /tmp/.X11-unix/X10; " +
          "nohup Xvnc :10 -geometry 1920x1080 -depth 24 -SecurityTypes None -rfbport 5900 -AlwaysShared -AcceptSetDesktopSize >/tmp/xvnc.log 2>&1 & " +
          "sleep 2; " +
          "pkill -f 'websockify 6080' 2>/dev/null || true; " +
          "nohup websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 &",
        ],
        AttachStdout: false,
        AttachStderr: false,
      });
      await exec.start({ Detach: true });
      // Wait for Xvfb+x0vncserver+websockify to fully start (exec script sleeps 2+1=3s)
      await new Promise((r) => setTimeout(r, 3500));
      console.info(`[docker] Xvfb restarted for container ${containerId.slice(0, 12)}`);
    } catch (err) {
      console.warn(`[docker] Failed to restart Xvfb for container ${containerId.slice(0, 12)}:`, (err as Error).message);
    }
  }

  private async reconnectContainerNetwork(containerId: string): Promise<void> {
    // When docker compose down+up recreates the network under the same name, the old
    // NetworkID embedded in the container config is stale. Docker treats a connect() call
    // as an upsert: if a stale endpoint exists it replaces it; if already current it
    // returns 409 which we ignore. No explicit disconnect needed.
    try {
      await this.docker.getNetwork(config.DOCKER_NETWORK_NAME).connect({ Container: containerId });
    } catch (err: unknown) {
      if (statusCodeOf(err) !== 409) throw err;
    }
  }

  // Stop-only: preserves the container filesystem so data survives across stop/start.
  async stopSession(_sessionId: string, containerId: string): Promise<void> {
    console.info(`[docker] Stopping container ${containerId.slice(0, 12)}`);
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 });
      console.info(`[docker] Container ${containerId.slice(0, 12)} stopped`);
    } catch (err: unknown) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 304 || statusCode === 404) {
        // 304: already stopped, 404: already gone — both are fine
        console.info(`[docker] Container ${containerId.slice(0, 12)} already ${statusCode === 404 ? "gone" : "stopped"}`);
        return;
      }
      throw err;
    }
  }

  async destroySession(_sessionId: string, containerId: string | null): Promise<void> {
    if (!containerId) return;
    console.info(`[docker] Stopping and removing container ${containerId.slice(0, 12)}`);
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      console.info(`[docker] Container ${containerId.slice(0, 12)} removed`);
    } catch (err: unknown) {
      if (statusCodeOf(err) === 404) {
        console.info(`[docker] Container ${containerId.slice(0, 12)} already gone`);
        return;
      }
      throw err;
    }
  }

  async pauseSession(_sessionId: string, containerId: string): Promise<void> {
    console.info(`[docker] Pausing container ${containerId.slice(0, 12)}`);
    try {
      await this.docker.getContainer(containerId).pause();
      console.info(`[docker] Container ${containerId.slice(0, 12)} paused`);
    } catch (err: unknown) {
      const code = statusCodeOf(err);
      if (code === 409 || code === 404) return; // already paused or gone — idempotent
      throw err;
    }
  }

  async resumeSession(_sessionId: string, containerId: string): Promise<SessionEndpoint> {
    console.info(`[docker] Unpausing container ${containerId.slice(0, 12)}`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.unpause();
      console.info(`[docker] Container ${containerId.slice(0, 12)} unpaused`);
    } catch (err: unknown) {
      const code = statusCodeOf(err);
      if (code === 404) throw new WorkloadGoneError(`Container ${containerId.slice(0, 12)} not found during unpause`);
      if (code !== 409) throw err; // 409: already running — idempotent
    }

    const info = await container.inspect();
    const networkInfo = info.NetworkSettings.Networks[config.DOCKER_NETWORK_NAME];
    if (!networkInfo?.IPAddress) {
      throw new Error(`Container did not get an IP on network ${config.DOCKER_NETWORK_NAME}`);
    }
    return {
      containerId: container.id,
      containerName: info.Name.replace(/^\//, ""),
      internalApiUrl: `http://${networkInfo.IPAddress}:3000`,
    };
  }

  waitForReady(internalApiUrl: string): Promise<void> {
    return waitForHealth(internalApiUrl);
  }

  // Set the X11 CLIPBOARD selection inside the container via xclip.
  // This is the reliable way to paste text into Chrome running in the container —
  // ClientCutText (VNC clipboard) only sets PRIMARY, which Chrome's Ctrl+V ignores.
  async setClipboard(_sessionId: string, containerId: string, text: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
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

  async resizeDisplay(_sessionId: string, containerId: string, width: number, height: number): Promise<void> {
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: buildResizeDisplayCommand(width, height),
      AttachStdout: false,
      AttachStderr: false,
    });
    await exec.start({ Detach: true });
  }

  async listManagedWorkloads(): Promise<ManagedWorkload[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
    });
    return containers
      .filter((c) => c.Labels?.[SESSION_LABEL])
      .map((c) => ({
        ref: c.Id,
        sessionId: c.Labels[SESSION_LABEL],
        state: mapContainerState(c.State),
      }));
  }

  async prepareImages(): Promise<void> {
    // If the image already exists locally (e.g. a locally-built image like browsermint-browser:latest),
    // skip the pull entirely — docker.pull would fail with 404 for images not on Docker Hub.
    try {
      await this.docker.getImage(config.STEEL_BROWSER_IMAGE).inspect();
      console.info(`[docker] Image ${config.STEEL_BROWSER_IMAGE} already present locally, skipping pull`);
      return;
    } catch {
      // Image not found locally — proceed with pull
    }

    return new Promise((resolve) => {
      this.docker.pull(config.STEEL_BROWSER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          console.warn("[docker] Image pull failed (non-fatal):", err.message);
          return resolve();
        }
        this.docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) {
            console.warn("[docker] Image pull error:", err.message);
          }
          resolve();
        });
      });
    });
  }
}
