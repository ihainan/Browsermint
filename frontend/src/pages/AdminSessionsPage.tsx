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
      className="flex items-center gap-0.5 text-xs text-[#969493] font-normal hover:text-[#260f17] transition-colors"
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
    <div className="mx-auto w-full max-w-screen-2xl px-4 pt-5 pb-12">

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <div className="bg-white border border-[#edebeb] rounded-lg px-4 py-3">
          <p className="text-[11px] text-[#969493] uppercase tracking-wide mb-1">{t("admin.allSessions")}</p>
          <p className="text-2xl font-semibold tabular-nums text-[#260f17]">{sessions.length}</p>
        </div>
        <div className="bg-white border border-[#edebeb] rounded-lg px-4 py-3">
          <p className="text-[11px] text-[#969493] uppercase tracking-wide mb-1">{t("common.statuses.running")}</p>
          <p className="text-2xl font-semibold tabular-nums text-[#1dc99a]">{runningCount}</p>
        </div>
        <div className="bg-white border border-[#edebeb] rounded-lg px-4 py-3">
          <p className="text-[11px] text-[#969493] uppercase tracking-wide mb-1">{t("common.statuses.stopped")}</p>
          <p className="text-2xl font-semibold tabular-nums text-[#260f17]">{stoppedCount}</p>
        </div>
        <div className="bg-white border border-[#edebeb] rounded-lg px-4 py-3">
          <p className="text-[11px] text-[#969493] uppercase tracking-wide mb-1">{t("common.statuses.error")}</p>
          <p className="text-2xl font-semibold tabular-nums text-red-500">{errorCount}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#cac8c7] pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("admin.sessionSearchPlaceholder")}
            className="w-full pl-8 pr-3 py-1.5 bg-white border border-[#edebeb] rounded-sm text-[13px] text-[#260f17] placeholder-[#cac8c7] focus:outline-none focus:ring-2 focus:ring-[#1dc99a]/20 focus:border-[#1dc99a] transition-colors"
          />
        </div>
        <div className="flex rounded-sm border border-[#edebeb] overflow-hidden text-[12px]">
          {(["all", "running", "stopped", "error"] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={clsx(
                "px-3 py-1.5 transition-colors capitalize",
                statusFilter === f
                  ? "bg-[#260f17] text-white"
                  : "bg-white text-[#514f4f] hover:bg-[#f6f5f5]",
              )}
            >
              {f === "all" ? t("admin.filterAll") : f}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-[#edebeb]">
        {isPending ? (
          <div className="flex justify-center py-16">
            <Loader2 size={20} className="animate-spin text-[#cac8c7]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2">
            <Monitor size={18} className="text-[#cac8c7]" />
            <p className="text-[13px] text-[#969493]">
              {search || statusFilter !== "all" ? t("admin.noResults") : t("admin.noSessions")}
            </p>
          </div>
        ) : (
          <table className="text-[#260f17] text-[13px] w-full border-separate border-spacing-0 table-auto">
            <thead>
              <tr>
                <th className="px-2 py-3 text-left">
                  <SortButton col="status" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("status")}>
                    {t("admin.status")}
                  </SortButton>
                </th>
                <th className="px-2 py-3 text-left text-[#969493] text-xs font-normal">
                  {t("browsers.name")} / ID
                </th>
                <th className="px-2 py-3 text-left">
                  <SortButton col="owner" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("owner")}>
                    {t("admin.sessionOwner")}
                  </SortButton>
                </th>
                <th className="px-2 py-3 text-left text-[#969493] text-xs font-normal">
                  {t("admin.sessionConnections")}
                </th>
                <th className="px-2 py-3 text-left">
                  <SortButton col="lastActiveAt" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("lastActiveAt")}>
                    {t("admin.sessionLastActive")}
                  </SortButton>
                </th>
                <th className="px-2 py-3 text-left">
                  <SortButton col="createdAt" sortKey={sortKey} sortDir={sortDir} onClick={() => handleSort("createdAt")}>
                    {t("admin.sessionCreated")}
                  </SortButton>
                </th>
                <th className="px-2 py-3 text-left text-[#969493] text-xs font-normal">
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
    <tr className="border-t border-[#edebeb] hover:bg-[#fafafa] transition-colors">
      {/* Status */}
      <td className="p-0">
        <div className="flex h-12 items-center px-2">
          <StatusBadge status={session.status as Session["status"]} />
        </div>
      </td>
      {/* Name / ID */}
      <td className="p-0">
        <div className="flex h-12 flex-col justify-center px-2 min-w-0">
          <span className="text-[13px] text-[#260f17] truncate max-w-[180px]">
            {session.name ?? <span className="text-[#cac8c7]">—</span>}
          </span>
          <span className="text-[10px] text-[#cac8c7] font-mono">{session.id.slice(0, 8)}…</span>
        </div>
      </td>
      {/* Owner */}
      <td className="p-0">
        <div className="flex h-12 flex-col justify-center px-2 min-w-0">
          <span className="text-[13px] text-[#260f17] truncate max-w-[140px]">{session.user.username}</span>
          <span className="text-[10px] text-[#969493] truncate max-w-[140px]">{session.user.email}</span>
        </div>
      </td>
      {/* Connections (event count) */}
      <td className="p-0">
        <div className="flex h-12 items-center px-2 tabular-nums text-[13px] text-[#514f4f]">
          {session.eventCount}
        </div>
      </td>
      {/* Last active */}
      <td className="p-0 whitespace-nowrap">
        <div className="flex h-12 items-center px-2 text-[12px] text-[#514f4f]">
          {formatDateTime(session.lastActiveAt)}
        </div>
      </td>
      {/* Created */}
      <td className="p-0 whitespace-nowrap">
        <div className="flex h-12 items-center px-2 text-[12px] text-[#514f4f]">
          {formatDateTime(session.createdAt)}
        </div>
      </td>
      {/* Expires */}
      <td className="p-0 whitespace-nowrap">
        <div className="flex h-12 items-center px-2 text-[12px] text-[#514f4f]">
          {session.expiresAt ? formatDateTime(session.expiresAt) : <span className="text-[#cac8c7]">—</span>}
        </div>
      </td>
    </tr>
  );
}
