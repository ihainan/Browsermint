import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi, AdminSessionFull, Session } from "../api/client.ts";
import { Loader2, Monitor, Search } from "lucide-react";
import clsx from "clsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { StatusBadge } from "./OverviewPage.tsx";

type StatusFilter = "all" | "running" | "stopped" | "error";
type SortKey = "lastActiveAt" | "createdAt" | "status" | "owner";
type SortDir = "asc" | "desc";

function SortButton({
  col, sortKey, sortDir, onClick, children,
}: {
  col: SortKey; sortKey: SortKey; sortDir: SortDir;
  onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-0.5 text-xs font-normal transition-colors text-[var(--text-faint)] hover:text-[var(--text-strong)]"
    >
      {children}
      <span className="text-[10px] ml-0.5">
        {col !== sortKey ? "⇅" : sortDir === "asc" ? "↑" : "↓"}
      </span>
    </button>
  );
}

export default function AdminSessionsPage() {
  const { t, formatDateTime } = useI18n();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("lastActiveAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isPending } = useQuery({
    queryKey: ["admin", "sessions"],
    queryFn: () => adminApi.listSessions().then((r) => r.data.sessions),
    refetchInterval: 10_000,
  });
  const sessions = data ?? [];

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = useMemo(() => {
    let list = sessions;
    if (statusFilter !== "all") {
      if (statusFilter === "stopped") {
        list = list.filter((s) => s.status === "stopped" || s.status === "stopping");
      } else {
        list = list.filter((s) => s.status === statusFilter);
      }
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          (s.name ?? "").toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.user.username.toLowerCase().includes(q) ||
          s.user.email.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "lastActiveAt")
        cmp = new Date(a.lastActiveAt).getTime() - new Date(b.lastActiveAt).getTime();
      else if (sortKey === "createdAt")
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      else if (sortKey === "status") cmp = a.status.localeCompare(b.status);
      else if (sortKey === "owner") cmp = a.user.username.localeCompare(b.user.username);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [sessions, statusFilter, search, sortKey, sortDir]);

  const runningCount = sessions.filter((s) => s.status === "running").length;
  const stoppedCount = sessions.filter((s) => s.status === "stopped" || s.status === "stopping").length;
  const errorCount = sessions.filter((s) => s.status === "error").length;

  return (
    <div className="page-wrap">

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="surface-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide mb-1 text-[var(--text-faint)]">{t("admin.allSessions")}</p>
          <p className="text-2xl font-semibold tabular-nums text-[var(--text-strong)]">{sessions.length}</p>
        </div>
        <div className="surface-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide mb-1 text-[var(--text-faint)]">{t("common.statuses.running")}</p>
          <p className="text-2xl font-semibold tabular-nums text-[var(--brand-main)]">{runningCount}</p>
        </div>
        <div className="surface-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide mb-1 text-[var(--text-faint)]">{t("common.statuses.stopped")}</p>
          <p className="text-2xl font-semibold tabular-nums text-[var(--text-strong)]">{stoppedCount}</p>
        </div>
        <div className="surface-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide mb-1 text-[var(--text-faint)]">{t("common.statuses.error")}</p>
          <p className="text-2xl font-semibold tabular-nums text-red-500">{errorCount}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-faint)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("admin.sessionSearchPlaceholder")}
            className="control-input pl-8 py-2"
          />
        </div>
        <div
          className="flex overflow-hidden text-[12px] rounded-[var(--radius-control)]"
          style={{ border: "1px solid var(--line-soft)" }}
        >
          {(["all", "running", "stopped", "error"] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className="px-3 py-2 transition-colors capitalize"
              style={statusFilter === f
                ? { background: "var(--text-strong)", color: "#fffdf9" }
                : { background: "rgba(255,255,255,0.72)", color: "var(--text-main)" }
              }
            >
              {f === "all" ? t("admin.filterAll") : f}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="surface-card-strong">
        {isPending ? (
          <div className="flex justify-center py-16">
            <Loader2 size={20} className="animate-spin text-[var(--text-faint)]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2">
            <Monitor size={18} className="text-[var(--text-faint)]" />
            <p className="text-[13px] text-[var(--text-soft)]">
              {search || statusFilter !== "all" ? t("admin.noResults") : t("admin.noSessions")}
            </p>
          </div>
        ) : (
          <table
            className="w-full border-separate border-spacing-0 table-auto text-[13px]"
            style={{ color: "var(--text-strong)" }}
          >
            <thead>
              <tr>
                <th className="px-3 py-3 text-left">
                  <SortButton col="status" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("status")}>
                    {t("admin.status")}
                  </SortButton>
                </th>
                <th className="px-3 py-3 text-left text-xs font-normal text-[var(--text-faint)]">
                  {t("browsers.name")} / ID
                </th>
                <th className="px-3 py-3 text-left">
                  <SortButton col="owner" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("owner")}>
                    {t("admin.sessionOwner")}
                  </SortButton>
                </th>
                <th className="px-3 py-3 text-left text-xs font-normal text-[var(--text-faint)]">
                  {t("admin.sessionConnections")}
                </th>
                <th className="px-3 py-3 text-left">
                  <SortButton col="lastActiveAt" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("lastActiveAt")}>
                    {t("admin.sessionLastActive")}
                  </SortButton>
                </th>
                <th className="px-3 py-3 text-left">
                  <SortButton col="createdAt" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("createdAt")}>
                    {t("admin.sessionCreated")}
                  </SortButton>
                </th>
                <th className="px-3 py-3 text-left text-xs font-normal text-[var(--text-faint)]">
                  {t("admin.sessionExpires")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((session) => (
                <SessionRow key={session.id} session={session} formatDateTime={formatDateTime} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  formatDateTime,
}: {
  session: AdminSessionFull;
  formatDateTime: (d: string) => string;
}) {
  return (
    <tr
      className="border-t transition-colors hover:bg-[var(--bg-soft)]"
      style={{ borderColor: "var(--line-soft)" }}
    >
      <td className="p-0">
        <div className="flex h-12 items-center px-3">
          <StatusBadge status={session.status as Session["status"]} />
        </div>
      </td>
      <td className="p-0">
        <div className="flex h-12 flex-col justify-center px-3 min-w-0">
          <span className="text-[13px] truncate max-w-[180px] text-[var(--text-strong)]">
            {session.name ?? <span className="text-[var(--text-faint)]">—</span>}
          </span>
          <span className="text-[10px] font-mono text-[var(--text-faint)]">{session.id.slice(0, 8)}…</span>
        </div>
      </td>
      <td className="p-0">
        <div className="flex h-12 flex-col justify-center px-3 min-w-0">
          <span className="text-[13px] truncate max-w-[140px] text-[var(--text-strong)]">
            {session.user.username}
          </span>
          <span className="text-[10px] truncate max-w-[140px] text-[var(--text-soft)]">
            {session.user.email}
          </span>
        </div>
      </td>
      <td className="p-0">
        <div className="flex h-12 items-center px-3 tabular-nums text-[13px] text-[var(--text-main)]">
          {session.eventCount}
        </div>
      </td>
      <td className="p-0 whitespace-nowrap">
        <div className="flex h-12 items-center px-3 text-[12px] text-[var(--text-main)]">
          {formatDateTime(session.lastActiveAt)}
        </div>
      </td>
      <td className="p-0 whitespace-nowrap">
        <div className="flex h-12 items-center px-3 text-[12px] text-[var(--text-main)]">
          {formatDateTime(session.createdAt)}
        </div>
      </td>
      <td className="p-0 whitespace-nowrap">
        <div className="flex h-12 items-center px-3 text-[12px] text-[var(--text-main)]">
          {session.expiresAt
            ? formatDateTime(session.expiresAt)
            : <span className="text-[var(--text-faint)]">—</span>}
        </div>
      </td>
    </tr>
  );
}
