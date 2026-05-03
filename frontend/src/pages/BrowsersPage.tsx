import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionsApi, Session } from "../api/client.ts";
import {
  Plus,
  Trash2,
  Loader2,
  ExternalLink,
  Play,
  Pause,
  MoreHorizontal,
  Copy,
  Check,
  Globe,
  ChevronDown,
} from "lucide-react";
import clsx from "clsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { getSessionStatusLabel } from "../i18n/sessionStatus.ts";
import { StatusBadge, daysUntilExpiry } from "./OverviewPage.tsx";
import { getSessionNameValidationError } from "./sessionNameValidation.ts";

const EXPIRY_WARNING_DAYS = 30;
const PER_PAGE = 25;

function formatOnlineTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  if (s > 0) return `${s}s`;
  return "—";
}

function effectiveOnlineMs(session: Session): number {
  const base = session.onlineMs ?? 0;
  if (session.status === "running" && session.runningStartedAt) {
    return base + Math.max(0, Date.now() - new Date(session.runningStartedAt).getTime());
  }
  return base;
}

type StatusFilter = Session["status"] | "all";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="p-0.5 text-[var(--text-faint)] hover:text-[var(--text-soft)] transition-colors rounded"
      title="Copy"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function StatusFilterDropdown({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options: StatusFilter[] = ["all", "running", "creating", "stopping", "stopped", "error"];

  const label =
    value === "all"
      ? t("browsers.allStatuses")
      : getSessionStatusLabel(locale, value as Session["status"]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-control)] text-[13px] transition-colors"
        style={{
          background: "rgba(255,255,255,0.72)",
          border: "1px solid var(--line-soft)",
          color: "var(--text-main)",
        }}
      >
        <span className="text-xs text-[var(--text-faint)]">{t("browsers.filterStatus")}</span>
        <span className="font-medium">{label}</span>
        <ChevronDown size={13} className="text-[var(--text-faint)]" />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-40 py-1 z-20 surface-card-strong"
          style={{ boxShadow: "var(--shadow-panel)" }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className="w-full flex items-center justify-between px-3 py-2 text-[13px] transition-colors hover:bg-[var(--bg-soft)]"
              style={{ color: "var(--text-main)" }}
            >
              <span>
                {opt === "all"
                  ? t("browsers.allStatuses")
                  : getSessionStatusLabel(locale, opt as Session["status"])}
              </span>
              {value === opt && <Check size={13} style={{ color: "var(--brand-strong)" }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RowActions({
  session,
  onStop,
  onStart,
  onDelete,
  stopPending,
  startPending,
}: {
  session: Session;
  onStop: () => void;
  onStart: () => void;
  onDelete: () => void;
  stopPending: boolean;
  startPending: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const iconBtn = "p-1.5 rounded-lg transition-colors text-[var(--text-faint)] hover:text-[var(--text-soft)] hover:bg-[var(--bg-soft)]";

  return (
    <div ref={ref} className="relative flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {(session.status === "running" || session.status === "paused") && (
        <button
          onClick={() => window.open(`/sessions/${session.id}`, "_blank")}
          className={iconBtn}
          title="Open"
        >
          <ExternalLink size={14} />
        </button>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={iconBtn}
        title={t("sessions.moreOptions")}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-40 py-1 z-20 surface-card-strong"
          style={{ boxShadow: "var(--shadow-panel)" }}
        >
          {session.status === "running" && (
            <button
              onClick={() => { setOpen(false); onStop(); }}
              disabled={stopPending}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-soft)] disabled:opacity-50"
              style={{ color: "var(--text-main)" }}
            >
              {stopPending ? <Loader2 size={13} className="animate-spin" /> : <Pause size={13} />}
              {t("sessions.disable")}
            </button>
          )}
          {(session.status === "stopped" || session.status === "error") && (
            <button
              onClick={() => { setOpen(false); onStart(); }}
              disabled={startPending}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-soft)] disabled:opacity-50"
              style={{ color: "var(--text-main)" }}
            >
              {startPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {t("sessions.resume")}
            </button>
          )}
          <button
            onClick={() => { setOpen(false); onDelete(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors text-red-500 hover:bg-[var(--danger-soft)]"
          >
            <Trash2 size={13} />
            {t("sessions.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function BrowsersPage() {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();

  const [newSessionName, setNewSessionName] = useState("");
  const [deleteConfirmModalId, setDeleteConfirmModalId] = useState<string | null>(null);
  const [newBrowserModalOpen, setNewBrowserModalOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);

  const { data, isPending } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list().then((r) => r.data.sessions),
    refetchInterval: 5000,
  });
  const sessions = data ?? [];

  const createMutation = useMutation({
    mutationFn: (name: string) => sessionsApi.create({ name }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setNewBrowserModalOpen(false);
      setNewSessionName("");
      window.open(`/sessions/${res.data.session.id}`, "_blank");
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        t("sessions.createBrowserFailed");
      setCreateError(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setDeleteConfirmModalId(null);
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.stop(id),
    onMutate: (id) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => (s.id === id ? { ...s, status: "stopping" as const } : s))
      );
    },
    onSuccess: (res) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => (s.id === res.data.session.id ? res.data.session : s))
      );
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.start(id),
    onMutate: (id) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => (s.id === id ? { ...s, status: "creating" as const } : s))
      );
    },
    onSuccess: (res) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => (s.id === res.data.session.id ? res.data.session : s))
      );
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  function getNameValidationError(name: string): string {
    return getSessionNameValidationError(name, sessions, t);
  }

  function handleCreate() {
    const trimmed = newSessionName.trim();
    const err = getNameValidationError(trimmed);
    if (err) { setCreateError(err); return; }
    setCreateError("");
    createMutation.mutate(trimmed);
  }

  const nameError = newSessionName && !createMutation.isPending ? getNameValidationError(newSessionName) : "";
  const canCreate = !createMutation.isPending && !getNameValidationError(newSessionName);

  const filtered =
    statusFilter === "all" ? sessions : sessions.filter((s) => s.status === statusFilter);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const page = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const from = filtered.length === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, filtered.length);

  return (
    <div className="page-wrap">

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-5">
        <StatusFilterDropdown value={statusFilter} onChange={setStatusFilter} />
        <button
          onClick={() => setNewBrowserModalOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-[var(--radius-control)]"
          style={{ background: "var(--text-strong)", color: "#fffdf9" }}
          onMouseEnter={e => (e.currentTarget.style.background = "#16120e")}
          onMouseLeave={e => (e.currentTarget.style.background = "var(--text-strong)")}
        >
          <Plus size={13} />
          {t("sessions.newBrowser")}
        </button>
      </div>

      {/* Table */}
      <div className="surface-card-strong">
        {isPending && sessions.length === 0 ? (
          <div className="flex justify-center py-16">
            <Loader2 size={20} className="animate-spin text-[var(--text-faint)]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: "var(--bg-soft)" }}
            >
              <Globe size={18} className="text-[var(--text-faint)]" />
            </div>
            <p className="text-[13px] text-[var(--text-soft)]">{t("sessions.noBrowsers")}</p>
          </div>
        ) : (
          <>
            <table
              className="w-full border-separate border-spacing-0 table-fixed text-[13px]"
              style={{ color: "var(--text-strong)" }}
            >
              <thead>
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[8%] text-[var(--text-faint)]">
                    {t("browsers.filterStatus")}
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[13%] text-[var(--text-faint)]">
                    {t("browsers.browserId")}
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[18%] text-[var(--text-faint)]">
                    {t("browsers.name")}
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[15%] text-[var(--text-faint)]">
                    {t("browsers.started")}
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[15%] text-[var(--text-faint)]">
                    {t("browsers.lastActive")}
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[11%] text-[var(--text-faint)]">
                    {t("browsers.onlineTime")}
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-normal w-[12%] text-[var(--text-faint)]">
                    {t("browsers.expiresAt")}
                  </th>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {paginated.map((session) => (
                  <tr
                    key={session.id}
                    className={clsx(
                      "border-t transition-colors",
                      (session.status === "running" || session.status === "paused")
                        ? "cursor-pointer hover:bg-[var(--bg-soft)]"
                        : "hover:bg-[var(--bg-soft)]"
                    )}
                    style={{ borderColor: "var(--line-soft)" }}
                    onClick={() =>
                      (session.status === "running" || session.status === "paused") &&
                      window.open(`/sessions/${session.id}`, "_blank")
                    }
                  >
                    <td className="p-0">
                      <div className="flex h-12 items-center px-3">
                        <StatusBadge status={session.status} />
                      </div>
                    </td>
                    <td className="p-0">
                      <div className="flex h-12 items-center px-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="font-mono text-[var(--text-strong)]">
                            {session.id.slice(0, 8)}…
                          </span>
                          <CopyButton value={session.id} />
                        </span>
                      </div>
                    </td>
                    <td className="p-0 overflow-hidden">
                      <div className="flex h-12 items-center px-3 min-w-0">
                        {session.name
                          ? <span className="truncate" title={session.name}>{session.name}</span>
                          : <span className="text-[var(--text-faint)]">—</span>}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-3 text-[var(--text-main)]">
                        {formatDateTime(session.createdAt)}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-3 text-[var(--text-main)]">
                        {formatDateTime(session.lastActiveAt)}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-3 font-mono text-[var(--text-main)]">
                        {formatOnlineTime(effectiveOnlineMs(session))}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-3">
                        {(() => {
                          const days = daysUntilExpiry(session.expiresAt);
                          if (days === null) return <span className="text-[var(--text-faint)]">—</span>;
                          if (days <= 0) return <span className="font-medium text-red-500">{t("sessions.expired")}</span>;
                          if (days <= 7) return <span className="text-red-500">{formatDateTime(session.expiresAt!)}</span>;
                          if (days <= EXPIRY_WARNING_DAYS) return <span className="text-amber-600">{formatDateTime(session.expiresAt!)}</span>;
                          return <span className="text-[var(--text-main)]">{formatDateTime(session.expiresAt!)}</span>;
                        })()}
                      </div>
                    </td>
                    <td className="p-0">
                      <div className="flex h-12 items-center justify-end px-2">
                        <RowActions
                          session={session}
                          onStop={() => stopMutation.mutate(session.id)}
                          onStart={() => startMutation.mutate(session.id)}
                          onDelete={() => setDeleteConfirmModalId(session.id)}
                          stopPending={stopMutation.isPending && stopMutation.variables === session.id}
                          startPending={startMutation.isPending && startMutation.variables === session.id}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            <div
              className="px-4 py-3 flex items-center justify-between border-t"
              style={{ borderColor: "var(--line-soft)" }}
            >
              <span className="text-xs text-[var(--text-faint)]">
                {t("browsers.viewing", { from, to, total: filtered.length })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed rounded-[var(--radius-control)]"
                  style={{
                    color: "var(--text-main)",
                    border: "1px solid var(--line-soft)",
                    background: "rgba(255,255,255,0.72)",
                  }}
                >
                  {t("browsers.previous")}
                </button>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed rounded-[var(--radius-control)]"
                  style={{
                    color: "var(--text-main)",
                    border: "1px solid var(--line-soft)",
                    background: "rgba(255,255,255,0.72)",
                  }}
                >
                  {t("browsers.next")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create modal */}
      {newBrowserModalOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 backdrop-blur-sm"
          style={{ background: "rgba(34, 29, 23, 0.35)" }}
          onClick={() => {
            setNewBrowserModalOpen(false);
            setNewSessionName("");
            setCreateError("");
          }}
        >
          <div
            className="surface-panel p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-strong)" }}>
              {t("sessions.newBrowserModalTitle")}
            </h3>
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => {
                setNewSessionName(e.target.value);
                setCreateError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder={t("sessions.browserNamePlaceholder")}
              maxLength={64}
              autoFocus
              className={clsx(
                "control-input",
                nameError && "border-[var(--danger-main)] focus:border-[var(--danger-main)]"
              )}
              disabled={createMutation.isPending}
            />
            {(nameError || (createError && !nameError)) && (
              <p className="mt-1.5 text-xs text-[var(--danger-main)]">{nameError || createError}</p>
            )}
            {createMutation.isPending && (
              <p className="mt-1.5 text-xs text-[var(--text-soft)]">{t("sessions.startingHint")}</p>
            )}
            <div className="flex gap-2 justify-end mt-4">
              <button
                onClick={() => {
                  setNewBrowserModalOpen(false);
                  setNewSessionName("");
                  setCreateError("");
                }}
                className="button-secondary px-3.5 py-2 text-xs"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                className="button-primary px-3.5 py-2 text-xs"
              >
                {createMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Plus size={11} />
                )}
                {createMutation.isPending ? t("sessions.starting") : t("common.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteConfirmModalId && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 backdrop-blur-sm"
          style={{ background: "rgba(34, 29, 23, 0.35)" }}
          onClick={() => setDeleteConfirmModalId(null)}
        >
          <div
            className="surface-panel p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-1" style={{ color: "var(--text-strong)" }}>
              {t("sessions.deleteBrowserTitle")}
            </h3>
            <p className="text-xs mb-5 text-[var(--text-soft)]">{t("sessions.deleteBrowserHint")}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirmModalId(null)}
                className="button-secondary px-3.5 py-2 text-xs"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirmModalId)}
                disabled={deleteMutation.isPending}
                className="button-danger px-3.5 py-2 text-xs"
              >
                {deleteMutation.isPending && <Loader2 size={11} className="animate-spin" />}
                {t("sessions.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
