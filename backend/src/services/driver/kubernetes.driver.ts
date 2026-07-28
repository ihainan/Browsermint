import * as k8s from "@kubernetes/client-node";
import { Writable, Readable } from "stream";
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
  BROWSER_STARTUP_COMMAND,
} from "./session-driver.js";

const CHROME_PROFILE_DIR = "/data/chrome-profile";
const POD_POLL_INTERVAL_MS = 2000;
const POD_DELETE_TIMEOUT_MS = 60_000;

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e.code ?? e.statusCode ?? e.response?.statusCode;
}

function isNotFound(err: unknown): boolean {
  return httpStatusOf(err) === 404;
}

function isConflict(err: unknown): boolean {
  return httpStatusOf(err) === 409;
}

export class KubernetesDriver implements SessionDriver {
  readonly pauseReleasesWorkload = true;
  readonly resumeTimeoutMs: number;

  private core: k8s.CoreV1Api;
  private exec: k8s.Exec;
  private namespace: string;

  constructor() {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      // Outside a pod (local dev against a kubeconfig)
      kc.loadFromDefault();
    }
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.exec = new k8s.Exec(kc);
    this.namespace = config.K8S_NAMESPACE;
    this.resumeTimeoutMs = config.K8S_POD_START_TIMEOUT_MS;
  }

  private podName(sessionId: string): string {
    return `${WORKLOAD_PREFIX}${sessionId}`;
  }

  private serviceName(sessionId: string): string {
    // Legacy: per-session Services existed in early deployments; kept only for
    // cleanup. Chrome's remote-debugging endpoints reject any non-IP Host
    // header ("Host header is specified and is not an IP address or
    // localhost"), so addressing must use the Pod IP, exactly like the Docker
    // driver uses the container IP.
    return `${WORKLOAD_PREFIX}${sessionId}`;
  }

  private pvcName(sessionId: string): string {
    return `${WORKLOAD_PREFIX}${sessionId}-profile`;
  }

  private labels(sessionId: string): Record<string, string> {
    return { [MANAGED_LABEL]: "true", [SESSION_LABEL]: sessionId };
  }

  private buildPodSpec(sessionId: string): k8s.V1Pod {
    // DOMAIN/CDP_DOMAIN are cosmetic for Steel (mirrors the Docker driver
    // passing the container name, which the backend cannot resolve either).
    const env = {
      ...buildBrowserEnv(this.podName(sessionId)),
      CHROME_USER_DATA_DIR: CHROME_PROFILE_DIR,
    };
    // Chrome refuses a profile containing Singleton* symlinks left behind by a
    // non-graceful pod death (the lock references a dead hostname/PID). The NFS
    // profile survives the pod, so clear stale locks on every start.
    const command = `rm -f ${CHROME_PROFILE_DIR}/Singleton* 2>/dev/null; ${BROWSER_STARTUP_COMMAND}`;

    return {
      metadata: {
        name: this.podName(sessionId),
        labels: this.labels(sessionId),
      },
      spec: {
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 30,
        ...(config.K8S_IMAGE_PULL_SECRET
          ? { imagePullSecrets: [{ name: config.K8S_IMAGE_PULL_SECRET }] }
          : {}),
        containers: [
          {
            name: "browser",
            image: config.STEEL_BROWSER_IMAGE,
            command: ["/bin/sh", "-c"],
            args: [command],
            env: Object.entries(env).map(([name, value]) => ({ name, value })),
            ports: [
              { containerPort: 3000, name: "api" },
              { containerPort: 9223, name: "cdp" },
              { containerPort: 6080, name: "vnc" },
            ],
            readinessProbe: {
              httpGet: { path: "/v1/health", port: 3000 },
              initialDelaySeconds: 5,
              periodSeconds: 3,
              failureThreshold: 40,
            },
            resources: {
              requests: {
                cpu: config.K8S_SESSION_CPU_REQUEST,
                memory: config.K8S_SESSION_MEMORY_REQUEST,
              },
              limits: {
                cpu: config.K8S_SESSION_CPU_LIMIT,
                memory: config.K8S_SESSION_MEMORY_LIMIT,
              },
            },
            volumeMounts: [
              { name: "profile", mountPath: "/data" },
              { name: "shm", mountPath: "/dev/shm" },
            ],
          },
        ],
        volumes: [
          { name: "profile", persistentVolumeClaim: { claimName: this.pvcName(sessionId) } },
          { name: "shm", emptyDir: { medium: "Memory", sizeLimit: config.K8S_SHM_SIZE } },
        ],
      },
    };
  }

  private async ensurePvc(sessionId: string): Promise<void> {
    const body: k8s.V1PersistentVolumeClaim = {
      metadata: { name: this.pvcName(sessionId), labels: this.labels(sessionId) },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: config.K8S_STORAGE_CLASS,
        resources: { requests: { storage: config.K8S_PVC_SIZE } },
      },
    };
    try {
      await this.core.createNamespacedPersistentVolumeClaim({ namespace: this.namespace, body });
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
  }

  private async getPod(name: string): Promise<k8s.V1Pod | null> {
    try {
      return await this.core.readNamespacedPod({ name, namespace: this.namespace });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // Deterministic pod names mean a recreate races a Terminating pod: delete and
  // poll until the name is fully gone before creating again.
  private async deletePodAndWait(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ name, namespace: this.namespace });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    const deadline = Date.now() + POD_DELETE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.getPod(name))) return;
      await new Promise((r) => setTimeout(r, POD_POLL_INTERVAL_MS));
    }
    throw new Error(`Pod ${name} did not terminate within ${POD_DELETE_TIMEOUT_MS}ms`);
  }

  private async waitForPodReady(name: string): Promise<k8s.V1Pod> {
    const deadline = Date.now() + config.K8S_POD_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pod = await this.getPod(name);
      if (pod) {
        const phase = pod.status?.phase;
        if (phase === "Failed" || phase === "Succeeded") {
          throw new Error(`Pod ${name} terminated during startup (phase=${phase})`);
        }
        const ready = pod.status?.conditions?.some(
          (c) => c.type === "Ready" && c.status === "True"
        );
        if (phase === "Running" && ready && pod.status?.podIP) return pod;
        const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason;
        if (waiting === "ImagePullBackOff" || waiting === "ErrImagePull" || waiting === "CrashLoopBackOff") {
          throw new Error(`Pod ${name} failed to start (${waiting})`);
        }
      }
      await new Promise((r) => setTimeout(r, POD_POLL_INTERVAL_MS));
    }
    throw new Error(`Pod ${name} did not become ready within ${config.K8S_POD_START_TIMEOUT_MS}ms`);
  }

  // Create PVC + Pod and wait until ready. Idempotent on the PVC so it also
  // serves as start/resume: the pod is recreated and the profile PVC carries
  // state across restarts. The endpoint uses the Pod IP (Chrome's debugging
  // endpoints reject DNS Host headers), so every resume path persists the
  // fresh internalApiUrl it returns.
  private async provision(sessionId: string): Promise<SessionEndpoint> {
    const podName = this.podName(sessionId);
    console.info(`[k8s] Provisioning session pod ${podName}`);
    await this.ensurePvc(sessionId);
    // A leftover pod (crashed, terminating, or from a previous backend crash)
    // must be removed first — names are deterministic.
    if (await this.getPod(podName)) {
      await this.deletePodAndWait(podName);
    }
    await this.core.createNamespacedPod({ namespace: this.namespace, body: this.buildPodSpec(sessionId) });
    let pod: k8s.V1Pod;
    try {
      pod = await this.waitForPodReady(podName);
    } catch (err) {
      // Leave the PVC in place — destroySession cleans up on delete, and a
      // retry can reuse it. Remove the broken pod so the next attempt does
      // not race it.
      await this.deletePodAndWait(podName).catch(() => {});
      throw err;
    }
    console.info(`[k8s] Session pod ${podName} ready (IP: ${pod.status!.podIP})`);
    return {
      containerId: podName,
      containerName: podName,
      internalApiUrl: `http://${pod.status!.podIP}:3000`,
    };
  }

  createSession(sessionId: string): Promise<SessionEndpoint> {
    return this.provision(sessionId);
  }

  startSession(sessionId: string, _ref: string): Promise<SessionEndpoint> {
    return this.provision(sessionId);
  }

  async stopSession(sessionId: string, _ref: string): Promise<void> {
    // Stop keeps the PVC (profile) and Service; only the pod goes away.
    console.info(`[k8s] Stopping session pod ${this.podName(sessionId)}`);
    await this.deletePodAndWait(this.podName(sessionId));
  }

  async destroySession(sessionId: string, _ref: string | null): Promise<void> {
    const podName = this.podName(sessionId);
    console.info(`[k8s] Destroying session ${sessionId} (pod + service + pvc)`);
    await this.deletePodAndWait(podName).catch((err) =>
      console.warn(`[k8s] Failed to delete pod ${podName}:`, (err as Error).message)
    );
    try {
      await this.core.deleteNamespacedService({ name: this.serviceName(sessionId), namespace: this.namespace });
    } catch (err) {
      if (!isNotFound(err)) console.warn(`[k8s] Failed to delete service:`, (err as Error).message);
    }
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ name: this.pvcName(sessionId), namespace: this.namespace });
    } catch (err) {
      if (!isNotFound(err)) console.warn(`[k8s] Failed to delete pvc:`, (err as Error).message);
    }
  }

  // Pause = delete the pod, keep PVC + Service. The caller is responsible for
  // saving tabs and closing Chrome gracefully first (pauseReleasesWorkload).
  async pauseSession(sessionId: string, _ref: string): Promise<void> {
    console.info(`[k8s] Pausing session ${sessionId} (deleting pod, keeping PVC)`);
    await this.deletePodAndWait(this.podName(sessionId));
  }

  resumeSession(sessionId: string, _ref: string): Promise<SessionEndpoint> {
    console.info(`[k8s] Resuming session ${sessionId} (recreating pod)`);
    return this.provision(sessionId);
  }

  waitForReady(internalApiUrl: string): Promise<void> {
    return waitForHealth(internalApiUrl);
  }

  async setClipboard(sessionId: string, _ref: string, text: string): Promise<void> {
    const podName = this.podName(sessionId);
    const stdin = Readable.from([Buffer.from(text, "utf-8")]);
    const devNull = new Writable({ write(_c, _e, cb) { cb(); } });
    await new Promise<void>((resolve, reject) => {
      this.exec
        .exec(
          this.namespace,
          podName,
          "browser",
          ["sh", "-c", "cat | DISPLAY=:10 xclip -selection clipboard -i"],
          devNull,
          devNull,
          stdin,
          false,
          (status) => {
            if (status.status === "Success") {
              // Give xclip a moment to process before the caller sends Ctrl+V
              setTimeout(resolve, 80);
            } else {
              reject(new Error(`clipboard exec failed: ${status.message ?? status.status}`));
            }
          }
        )
        .catch(reject);
    });
  }

  async listManagedWorkloads(): Promise<ManagedWorkload[]> {
    const list = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `${MANAGED_LABEL}=true`,
    });
    return list.items
      .filter((p) => p.metadata?.labels?.[SESSION_LABEL])
      .map((p) => ({
        ref: p.metadata!.name!,
        sessionId: p.metadata!.labels![SESSION_LABEL],
        state: this.mapPodState(p),
      }));
  }

  private mapPodState(pod: k8s.V1Pod): ManagedWorkloadState {
    // A terminating pod is transitional — leave it alone this tick.
    if (pod.metadata?.deletionTimestamp) return "starting";

    const phase = pod.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") return "exited";

    const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason;
    if (waiting === "CrashLoopBackOff" || waiting === "ImagePullBackOff" || waiting === "ErrImagePull") {
      return "exited";
    }

    const ready = pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
    if (phase === "Running" && ready) return "running";

    // Pending / Running-but-not-ready: give it the startup grace window, then
    // treat as exited so reconcile's auto-restart recreates it.
    const createdAt = pod.metadata?.creationTimestamp
      ? new Date(pod.metadata.creationTimestamp).getTime()
      : 0;
    if (Date.now() - createdAt < config.K8S_POD_START_TIMEOUT_MS) return "starting";
    return "exited";
  }

  async prepareImages(): Promise<void> {
    // Kubelet pulls images per pod via imagePullSecrets — nothing to do here.
  }

  // Services and PVCs outlive pods by design (pause keeps them). Remove the
  // ones whose session no longer exists in the DB.
  async sweepOrphanResources(activeSessionIds: string[]): Promise<void> {
    const active = new Set(activeSessionIds);
    const selector = `${MANAGED_LABEL}=true`;

    const services = await this.core.listNamespacedService({ namespace: this.namespace, labelSelector: selector });
    for (const svc of services.items) {
      const sessionId = svc.metadata?.labels?.[SESSION_LABEL];
      if (sessionId && !active.has(sessionId) && svc.metadata?.name) {
        console.info(`[k8s] Removing orphan service ${svc.metadata.name}`);
        await this.core
          .deleteNamespacedService({ name: svc.metadata.name, namespace: this.namespace })
          .catch((err) => { if (!isNotFound(err)) console.warn(`[k8s] orphan service delete failed:`, (err as Error).message); });
      }
    }

    const pvcs = await this.core.listNamespacedPersistentVolumeClaim({ namespace: this.namespace, labelSelector: selector });
    for (const pvc of pvcs.items) {
      const sessionId = pvc.metadata?.labels?.[SESSION_LABEL];
      if (sessionId && !active.has(sessionId) && pvc.metadata?.name) {
        console.info(`[k8s] Removing orphan pvc ${pvc.metadata.name}`);
        await this.core
          .deleteNamespacedPersistentVolumeClaim({ name: pvc.metadata.name, namespace: this.namespace })
          .catch((err) => { if (!isNotFound(err)) console.warn(`[k8s] orphan pvc delete failed:`, (err as Error).message); });
      }
    }
  }
}
