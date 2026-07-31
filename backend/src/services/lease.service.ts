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
export const LEASE_RENEW_HINT_MS = 15_000; // suggested client heartbeat interval

export type Lease = {
  leaseId: string;
  targetId: string;
  holderKey: string;
  holderLabel: string | null;
  expiresAt: Date;
};

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
 *  over silently — a holder that stops sending heartbeats has gone away. */
export async function acquireLease(
  sessionId: string, targetId: string, holderKey: string, holderLabel: string | null
): Promise<LeaseResult> {
  const now = new Date();
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
    } catch {
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
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS);
  const updated = await prisma.targetLease.updateMany({
    where: { sessionId, targetId, leaseId, expiresAt: { gt: new Date() } },
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
  if (!row || row.expiresAt <= new Date()) return null;
  return toLease(row);
}

/** True when this exact lease is still the live one — the check every write
 *  path (user input, agent CDP, REST navigate) has to pass. */
export async function holdsLease(
  sessionId: string, targetId: string, leaseId: string
): Promise<boolean> {
  const row = await prisma.targetLease.findFirst({
    where: { sessionId, targetId, leaseId, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return row !== null;
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
