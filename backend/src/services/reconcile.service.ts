import { prisma } from "../db/client.js";
import { driver, type ManagedWorkload } from "./driver/index.js";
import { WorkloadGoneError } from "./driver/session-driver.js";

export type SessionRecoveredCallback = (sessionId: string, internalApiUrl: string) => void;

const MAX_AUTO_RESTART = 3;

let reconcileRunning = false;

export async function reconcileSessions(
  startup = false,
  onSessionRecovered?: SessionRecoveredCallback
): Promise<void> {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    await _reconcileSessions(startup, onSessionRecovered);
  } finally {
    reconcileRunning = false;
  }
}

function onlineMsDelta(runningStartedAt: Date | null): number {
  return runningStartedAt ? Math.max(0, Date.now() - runningStartedAt.getTime()) : 0;
}

async function _reconcileSessions(
  startup: boolean,
  onSessionRecovered: SessionRecoveredCallback | undefined
): Promise<void> {
  let workloads: ManagedWorkload[] = [];
  try {
    workloads = await driver.listManagedWorkloads();
  } catch (err) {
    console.error("[reconcile] Failed to list managed workloads:", err);
    return;
  }

  // Workloads that exist in the engine but not in DB → remove
  for (const w of workloads) {
    const session = await prisma.session.findUnique({ where: { id: w.sessionId } });
    if (!session || session.deletedAt) {
      console.info(`[reconcile] Removing orphan workload ${w.ref} (session ${w.sessionId} not in DB)`);
      await driver.destroySession(w.sessionId, w.ref).catch((err) =>
        console.error(`[reconcile] Failed to remove orphan workload ${w.ref}:`, err)
      );
    }
  }

  const workloadByRef = new Map(workloads.map((w) => [w.ref, w]));

  // Attempt startSession with the shared auto-restart bookkeeping. Returns true
  // when the session is running again.
  async function tryAutoRestart(
    session: { id: string; containerId: string | null; runningStartedAt: Date | null; autoRestartAttempts: number },
    fromStatus: string
  ): Promise<void> {
    console.info(
      `[reconcile] Session ${session.id}: workload exited (${fromStatus}) — attempting auto-restart ` +
      `(attempt ${session.autoRestartAttempts + 1}/${MAX_AUTO_RESTART})`
    );
    try {
      const endpoint = await driver.startSession(session.id, session.containerId!);
      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: "running",
          autoRestartAttempts: 0,
          containerId: endpoint.containerId,
          containerName: endpoint.containerName,
          internalApiUrl: endpoint.internalApiUrl,
          runningStartedAt: new Date(Date.now()),
        },
      });
      console.info(`[reconcile] Session ${session.id}: auto-restart succeeded`);
      onSessionRecovered?.(session.id, endpoint.internalApiUrl);
    } catch (err: unknown) {
      if (err instanceof WorkloadGoneError || (err as { statusCode?: number }).statusCode === 404) {
        console.warn(`[reconcile] Session ${session.id}: workload gone — marking error`);
        await prisma.session.update({
          where: { id: session.id },
          data: {
            status: "error",
            onlineMs: { increment: onlineMsDelta(session.runningStartedAt) },
            runningStartedAt: null,
          },
        });
      } else {
        console.warn(
          `[reconcile] Session ${session.id}: auto-restart failed (attempt ${session.autoRestartAttempts + 1}):`,
          (err as Error).message
        );
        await prisma.session.update({
          where: { id: session.id },
          data: { autoRestartAttempts: { increment: 1 } },
        });
      }
    }
  }

  async function markError(session: { id: string; runningStartedAt: Date | null }): Promise<void> {
    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: "error",
        onlineMs: { increment: onlineMsDelta(session.runningStartedAt) },
        runningStartedAt: null,
      },
    });
  }

  // DB sessions with status=running/creating but workload missing or not running
  const activeSessions = await prisma.session.findMany({
    where: { status: { in: ["running", "creating"] }, deletedAt: null },
  });

  for (const session of activeSessions) {
    const workload = session.containerId ? workloadByRef.get(session.containerId) : undefined;

    if (!workload) {
      // With pause-by-deletion drivers a running session whose pod vanished is
      // recoverable — the profile PVC still exists — so auto-restart it.
      if (driver.pauseReleasesWorkload && session.status === "running" &&
          session.containerId && session.autoRestartAttempts < MAX_AUTO_RESTART) {
        await tryAutoRestart(session, "running/missing");
      } else if (session.status === "creating" && !session.containerId && !startup) {
        // Provisioning in flight: containerId is only written once create
        // finishes, and K8s pod startup can span several reconcile ticks.
        // Stuck-creating sessions are settled on startup instead.
      } else {
        console.info(`[reconcile] Session ${session.id}: workload not found — marking error`);
        await markError(session);
      }
    } else if (workload.state === "starting") {
      // Workload is still coming up (K8s scheduling/image pull) — leave it alone.
    } else if (workload.state === "paused") {
      // Backend crashed after pause but before updating DB — correct DB to "paused"
      console.info(`[reconcile] Session ${session.id}: workload paused but DB says running — correcting to "paused"`);
      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: "paused",
          onlineMs: { increment: onlineMsDelta(session.runningStartedAt) },
          runningStartedAt: null,
        },
      });
    } else if (workload.state !== "running") {
      const isExited = workload.state === "exited";
      if (isExited && session.autoRestartAttempts < MAX_AUTO_RESTART) {
        await tryAutoRestart(session, session.status);
      } else {
        const reason = !isExited
          ? `workload state is "${workload.state}"`
          : `auto-restart limit reached (${session.autoRestartAttempts}/${MAX_AUTO_RESTART})`;
        console.info(`[reconcile] Session ${session.id}: ${reason} — marking error`);
        await markError(session);
      }
    } else if (session.status === "creating" && startup) {
      // Workload is running but session is stuck in "creating" (backend crashed mid-init).
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
      await driver.stopSession(session.id, session.containerId).catch(() => {});
    }
    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: "stopped",
        onlineMs: { increment: onlineMsDelta(session.runningStartedAt) },
        runningStartedAt: null,
      },
    });
  }

  // Handle sessions whose DB status is "paused" — verify workload state matches
  const pausedDbSessions = await prisma.session.findMany({
    where: { status: "paused", deletedAt: null },
  });

  for (const session of pausedDbSessions) {
    const workload = session.containerId ? workloadByRef.get(session.containerId) : undefined;

    if (!workload) {
      if (driver.pauseReleasesWorkload) {
        // Healthy: pause deleted the workload by design; PVC holds the state.
      } else {
        console.info(`[reconcile] Session ${session.id}: paused but workload missing — marking error`);
        await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
      }
    } else if (workload.state === "paused") {
      // Healthy: DB paused + engine paused — nothing to do
    } else if (workload.state === "starting") {
      // Transitional (e.g. pod still terminating after pause) — leave it alone.
    } else if (workload.state === "running") {
      if (driver.pauseReleasesWorkload) {
        // A pod exists although pause should have deleted it — the backend
        // likely crashed mid-pause. Finish the job.
        console.info(`[reconcile] Session ${session.id}: paused but pod still running — completing pause`);
        await driver.pauseSession(session.id, session.containerId!).catch((err) =>
          console.error(`[reconcile] Failed to complete pause for session ${session.id}:`, err)
        );
      } else {
        // Backend crashed after unpause but before updating DB — correct DB to "running"
        console.info(`[reconcile] Session ${session.id}: workload running but DB says paused — correcting to "running"`);
        await prisma.session.update({
          where: { id: session.id },
          data: { status: "running", runningStartedAt: new Date(Date.now()) },
        });
      }
    } else {
      const isExited = workload.state === "exited";
      if (isExited && session.autoRestartAttempts < MAX_AUTO_RESTART) {
        console.info(
          `[reconcile] Session ${session.id}: paused workload exited — attempting auto-restart ` +
          `(attempt ${session.autoRestartAttempts + 1}/${MAX_AUTO_RESTART})`
        );
        try {
          const endpoint = await driver.startSession(session.id, session.containerId!);
          await prisma.session.update({
            where: { id: session.id },
            data: {
              status: "running",
              autoRestartAttempts: 0,
              containerId: endpoint.containerId,
              containerName: endpoint.containerName,
              internalApiUrl: endpoint.internalApiUrl,
              runningStartedAt: new Date(Date.now()),
            },
          });
          console.info(`[reconcile] Session ${session.id}: auto-restart from paused succeeded`);
          onSessionRecovered?.(session.id, endpoint.internalApiUrl);
        } catch (err: unknown) {
          if (err instanceof WorkloadGoneError || (err as { statusCode?: number }).statusCode === 404) {
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
          ? `workload state is "${workload.state}"`
          : `auto-restart limit reached (${session.autoRestartAttempts}/${MAX_AUTO_RESTART})`;
        console.info(`[reconcile] Session ${session.id}: paused — ${reason} — marking error`);
        await prisma.session.update({ where: { id: session.id }, data: { status: "error" } });
      }
    }
  }

  // Clean up running workloads left behind by failed create/start operations.
  // These sessions are in "error" state but their workload was started before the failure.
  const errorSessionsWithWorkload = await prisma.session.findMany({
    where: { status: "error", deletedAt: null, containerId: { not: null } },
  });

  for (const session of errorSessionsWithWorkload) {
    const workload = session.containerId ? workloadByRef.get(session.containerId) : undefined;
    if (workload && workload.state === "running") {
      console.info(`[reconcile] Session ${session.id}: error status but workload still running — removing`);
      await driver.destroySession(session.id, session.containerId!).catch((err) =>
        console.error(`[reconcile] Failed to remove workload for error session ${session.id}:`, err)
      );
      await prisma.session.update({
        where: { id: session.id },
        data: { containerId: null, containerName: null, internalApiUrl: null },
      });
    } else if (workload && workload.state === "exited" && session.autoRestartAttempts < MAX_AUTO_RESTART) {
      // Existing error session whose workload exited (e.g. host rebooted while backend ran old code).
      // Attempt auto-restart so the session self-heals without user intervention.
      console.info(
        `[reconcile] Session ${session.id}: error status with exited workload — attempting auto-restart ` +
        `(attempt ${session.autoRestartAttempts + 1}/${MAX_AUTO_RESTART})`
      );
      try {
        const endpoint = await driver.startSession(session.id, session.containerId!);
        await prisma.session.update({
          where: { id: session.id },
          data: {
            status: "running",
            autoRestartAttempts: 0,
            containerId: endpoint.containerId,
            containerName: endpoint.containerName,
            internalApiUrl: endpoint.internalApiUrl,
            runningStartedAt: new Date(Date.now()),
          },
        });
        console.info(`[reconcile] Session ${session.id}: auto-restart from error succeeded`);
        onSessionRecovered?.(session.id, endpoint.internalApiUrl);
      } catch (err: unknown) {
        if (err instanceof WorkloadGoneError || (err as { statusCode?: number }).statusCode === 404) {
          console.warn(`[reconcile] Session ${session.id}: workload gone during error auto-restart — clearing metadata`);
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

  // Engine-specific auxiliary resources (K8s Services/PVCs) whose session is
  // gone from the DB.
  if (driver.sweepOrphanResources) {
    try {
      const liveSessions = await prisma.session.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      await driver.sweepOrphanResources(liveSessions.map((s) => s.id));
    } catch (err) {
      console.error("[reconcile] Orphan resource sweep failed:", err);
    }
  }
}
