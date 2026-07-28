import { config } from "../../config.js";
import type { SessionDriver } from "./session-driver.js";
import { DockerDriver } from "./docker.driver.js";
import { KubernetesDriver } from "./kubernetes.driver.js";

export * from "./session-driver.js";

// Overrides may replace any driver method — and, for reconcile tests, the
// pause semantics flag. Same mechanism the old docker.service.ts offered.
export type DriverOverrides = Partial<
  Pick<
    SessionDriver,
    | "createSession"
    | "startSession"
    | "stopSession"
    | "destroySession"
    | "pauseSession"
    | "resumeSession"
    | "waitForReady"
    | "setClipboard"
    | "listManagedWorkloads"
    | "prepareImages"
    | "sweepOrphanResources"
  > & { pauseReleasesWorkload: boolean; resumeTimeoutMs: number }
>;

let driverOverrides: DriverOverrides = {};

export function setDriverOverridesForTests(overrides: DriverOverrides): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setDriverOverridesForTests can only be used when NODE_ENV=test");
  }
  driverOverrides = overrides;
}

export function resetDriverOverridesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetDriverOverridesForTests can only be used when NODE_ENV=test");
  }
  driverOverrides = {};
}

let realDriver: SessionDriver | null = null;

function getRealDriver(): SessionDriver {
  if (!realDriver) {
    realDriver =
      config.SESSION_DRIVER === "kubernetes" ? new KubernetesDriver() : new DockerDriver();
    console.info(`[driver] Using ${config.SESSION_DRIVER} session driver`);
  }
  return realDriver;
}

// Facade so call sites can `import { driver }` once; overrides are consulted
// per call, matching the old setDockerServiceOverridesForTests behavior.
export const driver: SessionDriver = {
  get pauseReleasesWorkload() {
    return driverOverrides.pauseReleasesWorkload ?? getRealDriver().pauseReleasesWorkload;
  },
  get resumeTimeoutMs() {
    return driverOverrides.resumeTimeoutMs ?? getRealDriver().resumeTimeoutMs;
  },
  createSession: (id) =>
    (driverOverrides.createSession ?? getRealDriver().createSession.bind(getRealDriver()))(id),
  startSession: (id, ref) =>
    (driverOverrides.startSession ?? getRealDriver().startSession.bind(getRealDriver()))(id, ref),
  stopSession: (id, ref) =>
    (driverOverrides.stopSession ?? getRealDriver().stopSession.bind(getRealDriver()))(id, ref),
  destroySession: (id, ref) =>
    (driverOverrides.destroySession ?? getRealDriver().destroySession.bind(getRealDriver()))(id, ref),
  pauseSession: (id, ref) =>
    (driverOverrides.pauseSession ?? getRealDriver().pauseSession.bind(getRealDriver()))(id, ref),
  resumeSession: (id, ref) =>
    (driverOverrides.resumeSession ?? getRealDriver().resumeSession.bind(getRealDriver()))(id, ref),
  waitForReady: (url) =>
    (driverOverrides.waitForReady ?? getRealDriver().waitForReady.bind(getRealDriver()))(url),
  setClipboard: (id, ref, text) =>
    (driverOverrides.setClipboard ?? getRealDriver().setClipboard.bind(getRealDriver()))(id, ref, text),
  listManagedWorkloads: () =>
    (driverOverrides.listManagedWorkloads ?? getRealDriver().listManagedWorkloads.bind(getRealDriver()))(),
  prepareImages: () =>
    (driverOverrides.prepareImages ?? getRealDriver().prepareImages.bind(getRealDriver()))(),
  sweepOrphanResources: (ids) => {
    if (driverOverrides.sweepOrphanResources) return driverOverrides.sweepOrphanResources(ids);
    const real = getRealDriver();
    return real.sweepOrphanResources ? real.sweepOrphanResources(ids) : Promise.resolve();
  },
};
