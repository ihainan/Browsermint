import Docker from "dockerode";
import { config } from "../config.js";
import { prisma } from "../db/client.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const CONTAINER_PREFIX = "steelyard-session-";
const MANAGED_LABEL = "steelyard.managed";
const SESSION_LABEL = "steelyard.session";
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
  const internalApiUrl = `http://${containerName}:3000`;

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
    ],
    HostConfig: {
      NetworkMode: config.DOCKER_NETWORK_NAME,
      // Phase 2: Memory: 2 * 1024 * 1024 * 1024, NanoCpus: 2e9
    },
  });

  await container.start();

  return {
    containerId: container.id,
    containerName,
    internalApiUrl,
  };
}

export async function waitForContainerReady(
  internalApiUrl: string
): Promise<void> {
  const healthUrl = `${internalApiUrl}/health`;
  const startTime = Date.now();

  while (Date.now() - startTime < HEALTH_POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
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

export async function stopAndRemoveContainer(
  containerId: string
): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404) return; // Already gone
    throw err;
  }
}

export async function reconcileContainers(): Promise<void> {
  let managedContainers: Docker.ContainerInfo[] = [];
  try {
    managedContainers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
    });
  } catch (err) {
    console.error("Failed to list Docker containers during reconcile:", err);
    return;
  }

  // Containers that exist in Docker but not in DB → remove
  for (const c of managedContainers) {
    const sessionId = c.Labels?.[SESSION_LABEL];
    if (!sessionId) continue;

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.deletedAt) {
      console.log(`Reconcile: removing orphan container ${c.Id.slice(0, 12)}`);
      await stopAndRemoveContainer(c.Id).catch(console.error);
    }
  }

  // DB sessions with status=running/creating but no matching container → mark error
  const runningInDb = await prisma.session.findMany({
    where: { status: { in: ["running", "creating"] }, deletedAt: null },
  });

  const containerIdSet = new Set(managedContainers.map((c) => c.Id));
  for (const session of runningInDb) {
    if (session.containerId && !containerIdSet.has(session.containerId)) {
      console.log(`Reconcile: container missing for session ${session.id}, marking error`);
      await prisma.session.update({
        where: { id: session.id },
        data: { status: "error" },
      });
    }
  }
}

export async function pullImageIfNeeded(): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(config.STEEL_BROWSER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        // Non-fatal: image may already be present locally
        console.warn("Image pull warning:", err.message);
        return resolve();
      }
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) {
          console.warn("Image pull progress error:", err.message);
        }
        resolve();
      });
    });
  });
}
