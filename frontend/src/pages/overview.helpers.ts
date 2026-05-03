import type { Session } from "../api/client.ts";

export function daysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

export function formatOnlineTimeBrief(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return "0m";
}

export function formatOnlineTimeFull(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function effectiveOnlineMs(session: Session, nowMs = Date.now()): number {
  const base = session.onlineMs ?? 0;
  if (session.status === "running" && session.runningStartedAt) {
    return base + Math.max(0, nowMs - new Date(session.runningStartedAt).getTime());
  }
  return base;
}
