import { config } from "./config.js";
import { prisma } from "./db/client.js";
import { createApp } from "./app.js";
import { reconcileContainers, pullImageIfNeeded, type SessionRecoveredCallback } from "./services/docker.service.js";
import { scheduleIdlePauseOnStartup } from "./services/proxy.service.js";
import { initCdpSession } from "./services/cdp.service.js";

const server = await createApp();

function runStartupTask(name: string, task: () => Promise<void>) {
  void task().catch((err) => {
    server.log.warn({ err }, `${name} failed`);
  });
}

const RECONCILE_INTERVAL_MS = 30_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

server.addHook("onReady", async () => {
  const onSessionRecovered: SessionRecoveredCallback = (sessionId, internalApiUrl) => {
    server.log.info(`[session] Session ${sessionId}: auto-restart succeeded, re-attaching CDP...`);
    void initCdpSession(sessionId, internalApiUrl).then((ok) => {
      if (!ok) {
        server.log.warn(`[session] Session ${sessionId}: CDP unreachable after auto-restart — marking error`);
        return prisma.session.update({ where: { id: sessionId }, data: { status: "error" } });
      }
      server.log.info(`[session] Session ${sessionId}: CDP re-attached after auto-restart`);
      scheduleIdlePauseOnStartup(sessionId);
    }).catch((err) => {
      server.log.warn({ err }, `[session] Failed to re-attach CDP for auto-restarted session ${sessionId}`);
    });
  };

  // Reconcile first (synchronously) so broken sessions are marked error before
  // we try to re-attach CDP — no point connecting to a session we're about to fix.
  server.log.info("Reconciling containers...");
  await reconcileContainers(true, onSessionRecovered).catch((err) => {
    server.log.warn({ err }, "Container reconcile failed");
  });

  // Re-attach CDP WebSockets for sessions that were running before this restart.
  // activeSessions is in-memory and is wiped on every restart; without this,
  // closeBrowserGracefully would have no WebSocket and fall back to docker stop
  // (SIGKILL), corrupting Chrome's profile.
  const runningSessions = await prisma.session.findMany({
    where: { status: "running", deletedAt: null, internalApiUrl: { not: null } },
  });
  if (runningSessions.length > 0) {
    server.log.info(`Re-attaching CDP for ${runningSessions.length} running session(s) after restart`);
    for (const s of runningSessions) {
      void initCdpSession(s.id, s.internalApiUrl!).then((ok) => {
        if (!ok) {
          server.log.warn(`[session] Session ${s.id}: CDP unreachable after restart — marking error`);
          return prisma.session.update({ where: { id: s.id }, data: { status: "error" } });
        }
        server.log.info(`[session] Session ${s.id}: CDP re-attached after restart`);
        // Schedule idle-pause timer — session has no WS connections after restart
        scheduleIdlePauseOnStartup(s.id);
      }).catch((err) => {
        server.log.warn({ err }, `[session] Failed to re-attach CDP for session ${s.id}`);
      });
    }
  }

  server.log.info("Pulling steel-browser image...");
  runStartupTask("Image pull", pullImageIfNeeded);

  // Periodically reconcile to recover sessions stuck in creating/stopping
  // (e.g., after a backend crash or restart mid-operation).
  reconcileTimer = setInterval(() => {
    void reconcileContainers(false, onSessionRecovered).catch((err) => {
      server.log.warn({ err }, "Periodic reconcile failed");
    });
  }, RECONCILE_INTERVAL_MS);
});

server.addHook("onClose", async () => {
  if (reconcileTimer) clearInterval(reconcileTimer);
  await prisma.$disconnect();
});

try {
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
  server.log.info(`Browsermint backend listening on port ${config.PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
