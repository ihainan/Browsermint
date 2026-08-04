import { randomBytes } from "crypto";
import { prisma } from "../db/client.js";

/**
 * Single-writer lease over one page target.
 *
 * Why here and not in the embedding platform: an agent holds its own BM token
 * and can open a CDP connection directly, so any arbiter outside this process
 * can be bypassed. User input, the agent's CDP bridge and the REST
 * navigate/viewport endpoints all funnel through Browsermint — this is the only
 * chokepoint that can actually enforce "one writer at a time".
 *
 * Every mutation is a conditional update carrying the random `leaseId`, so a
 * window that wakes up after its lease expired can never keep writing (the
 * classic fencing-token problem: wall-clock expiry alone is not enough).
 */

export const LEASE_TTL_MS = 45_000;        // renewed by heartbeat well inside this
export const LEASE_TTL_SQL = "45 seconds";  // same TTL, computed by Postgres
export const LEASE_RENEW_HINT_MS = 15_000; // suggested client heartbeat interval

export type Lease = {
  leaseId: string;
  targetId: string;
  holderKey: string;
  holderLabel: string | null;
  expiresAt: Date;
};

/** Postgres' clock — the single source of truth for expiry across replicas. */
async function dbNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return rows[0]?.now ?? new Date();
}

export type LeaseResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "held"; holderLabel: string | null; expiresAt: Date }
  | { ok: false; reason: "stale" };

function toLease(row: {
  leaseId: string; targetId: string; holderKey: string;
  holderLabel: string | null; expiresAt: Date;
}): Lease {
  return {
    leaseId: row.leaseId, targetId: row.targetId, holderKey: row.holderKey,
    holderLabel: row.holderLabel, expiresAt: row.expiresAt,
  };
}

/** Take the lease, or report who currently holds it. Expired leases are taken
 *  over silently — a holder that stops sending heartbeats has gone away.
 *
 *  All expiry arithmetic happens in Postgres. With several BM replicas each
 *  judging expiry by its own clock, a few seconds of drift is enough for two of
 *  them to believe they may write at the same time — which is precisely the
 *  thing this lease exists to prevent. */
export async function acquireLease(
  sessionId: string, targetId: string, holderKey: string, holderLabel: string | null
): Promise<LeaseResult> {
  const now = await dbNow();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const leaseId = randomBytes(16).toString("hex");

  const existing = await prisma.targetLease.findUnique({
    where: { sessionId_targetId: { sessionId, targetId } },
  });

  if (!existing) {
    try {
      const row = await prisma.targetLease.create({
        data: { sessionId, targetId, leaseId, holderKey, holderLabel, expiresAt },
      });
      return { ok: true, lease: toLease(row) };
    } catch (err: any) {
      // Only a unique-constraint collision means "someone beat us"; anything
      // else (connection lost, permission) must not be reported as "held".
      if (err?.code !== "P2002") throw err;
      // Lost the race on the unique index: fall through and report the winner.
      const winner = await prisma.targetLease.findUnique({
        where: { sessionId_targetId: { sessionId, targetId } },
      });
      if (!winner) return { ok: false, reason: "stale" };
      return { ok: false, reason: "held", holderLabel: winner.holderLabel, expiresAt: winner.expiresAt };
    }
  }

  const takeable = existing.expiresAt <= now || existing.holderKey === holderKey;
  if (!takeable) {
    return { ok: false, reason: "held", holderLabel: existing.holderLabel, expiresAt: existing.expiresAt };
  }
  // CAS on the row we just read: a concurrent takeover changes leaseId and this
  // update matches nothing.
  const updated = await prisma.targetLease.updateMany({
    where: { id: existing.id, leaseId: existing.leaseId },
    data: { leaseId, holderKey, holderLabel, expiresAt },
  });
  if (updated.count === 0) {
    const winner = await prisma.targetLease.findUnique({
      where: { sessionId_targetId: { sessionId, targetId } },
    });
    if (!winner) return { ok: false, reason: "stale" };
    return { ok: false, reason: "held", holderLabel: winner.holderLabel, expiresAt: winner.expiresAt };
  }
  return { ok: true, lease: { leaseId, targetId, holderKey, holderLabel, expiresAt } };
}

/** Extend the lease. Fails if this leaseId is no longer the current one. */
export async function renewLease(
  sessionId: string, targetId: string, leaseId: string
): Promise<LeaseResult> {
  const expiresAt = new Date((await dbNow()).getTime() + LEASE_TTL_MS);
  const updated = await prisma.targetLease.updateMany({
    where: { sessionId, targetId, leaseId, expiresAt: { gt: await dbNow() } },
    data: { expiresAt },
  });
  if (updated.count === 0) return { ok: false, reason: "stale" };
  const row = await prisma.targetLease.findUnique({
    where: { sessionId_targetId: { sessionId, targetId } },
  });
  if (!row) return { ok: false, reason: "stale" };
  return { ok: true, lease: toLease(row) };
}

/** Give it back. Releasing someone else's lease is a no-op, not an error. */
export async function releaseLease(
  sessionId: string, targetId: string, leaseId: string
): Promise<void> {
  await prisma.targetLease.deleteMany({ where: { sessionId, targetId, leaseId } });
}

/** Current holder, or null when free/expired. Never returns an expired lease. */
export async function currentLease(
  sessionId: string, targetId: string
): Promise<Lease | null> {
  const row = await prisma.targetLease.findUnique({
    where: { sessionId_targetId: { sessionId, targetId } },
  });
  if (!row || row.expiresAt <= await dbNow()) return null;
  return toLease(row);
}

/** True when this exact lease is still the live one — the check every write
 *  path (user input, agent CDP, REST navigate) has to pass. */
export async function holdsLease(
  sessionId: string, targetId: string, leaseId: string
): Promise<boolean> {
  // 单条查询里用 Postgres 自己的 now()，别先 dbNow() 再查——这是**输入热路径**：
  // 每个滚轮/鼠标事件都要过一遍，两次串行 DB 往返直接摊在「点了没反应」的那半秒里
  // （codex 会诊 2026-08-04：输入注入延迟的主要嫌疑）。语义不变：时钟真源仍是 DB。
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "TargetLease"
    WHERE "sessionId" = ${sessionId}::uuid AND "targetId" = ${targetId}
      AND "leaseId" = ${leaseId} AND "expiresAt" > now()
    LIMIT 1`;
  return rows.length > 0;
}

/** Is someone *other* than this holder driving the target right now? */
export async function isLockedByOther(
  sessionId: string, targetId: string, leaseId: string | null
): Promise<Lease | null> {
  const live = await currentLease(sessionId, targetId);
  if (!live) return null;
  if (leaseId && live.leaseId === leaseId) return null;
  return live;
}

/** Any live lease in this session? Used for writes we cannot attribute to a
 *  specific target (browser-level commands, non-flatten protocol nesting): if
 *  anything is being driven by a user, an unattributable write is refused. */
export async function anyLeaseHeld(sessionId: string): Promise<boolean> {
  const row = await prisma.targetLease.findFirst({
    where: { sessionId, expiresAt: { gt: await dbNow() } },
    select: { id: true },
  });
  return row !== null;
}

/** Drop leases for a target that no longer exists (closed tab, rebind after
 *  resume). Without this, rows for dead targets accumulate forever. */
export async function forgetTargetLeases(sessionId: string, targetId?: string): Promise<void> {
  try {
    const where = targetId ? { sessionId, targetId } : { sessionId };
    await prisma.targetLease.deleteMany({ where });
  } catch { /* cleanup is best-effort */ }
}

/** Periodic sweep of expired rows. Expiry is already enforced on read, so this
 *  is purely about not growing the table forever. */
export async function sweepExpiredLeases(): Promise<number> {
  try {
    const now = await dbNow();
    const res = await prisma.targetLease.deleteMany({ where: { expiresAt: { lte: now } } });
    return res.count;
  } catch {
    return 0;
  }
}
