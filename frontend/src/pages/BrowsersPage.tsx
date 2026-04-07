import { useState, useRef, useEffect } from "react";
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

const EXPIRY_WARNING_DAYS = 30;

const PER_PAGE = 25;

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
      className="p-0.5 text-[#969493] hover:text-[#514f4f] transition-colors rounded"
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
        className="flex items-center gap-2 px-3 py-1.5 bg-white border border-[#edebeb] rounded-sm text-[13px] text-[#514f4f] hover:border-[#cac8c7] transition-colors"
      >
        <span className="text-xs text-[#969493]">{t("browsers.filterStatus")}</span>
        <span className="font-medium">{label}</span>
        <ChevronDown size={13} className="text-[#969493]" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-36 bg-white rounded-md shadow-lg ring-[0.5px] ring-black/[0.07] py-1 z-20">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className="w-full flex items-center justify-between px-3 py-2 text-[13px] text-[#514f4f] hover:bg-[#fafafa] transition-colors"
            >
              <span>
                {opt === "all"
                  ? t("browsers.allStatuses")
                  : getSessionStatusLabel(locale, opt as Session["status"])}
              </span>
              {value === opt && <Check size={13} className="text-[#260f17]" />}
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

  return (
    <div ref={ref} className="relative flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {session.status === "running" && (
        <button
          onClick={() => window.open(`/sessions/${session.id}`, "_blank")}
          className="p-1.5 text-[#969493] hover:text-[#514f4f] hover:bg-[#f6f5f5] rounded-lg transition-colors"
          title="Open"
        >
          <ExternalLink size={14} />
        </button>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="p-1.5 text-[#969493] hover:text-[#514f4f] hover:bg-[#f6f5f5] rounded-lg transition-colors"
        title={t("sessions.moreOptions")}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 bg-white rounded-md shadow-lg ring-[0.5px] ring-black/[0.07] py-1 z-20 top-full">
          {session.status === "running" && (
            <button
              onClick={() => { setOpen(false); onStop(); }}
              disabled={stopPending}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[#514f4f] hover:bg-[#fafafa] transition-colors disabled:opacity-50"
            >
              {stopPending ? <Loader2 size={13} className="animate-spin" /> : <Pause size={13} />}
              {t("sessions.disable")}
            </button>
          )}
          {(session.status === "stopped" || session.status === "error") && (
            <button
              onClick={() => { setOpen(false); onStart(); }}
              disabled={startPending}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[#514f4f] hover:bg-[#fafafa] transition-colors disabled:opacity-50"
            >
              {startPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {t("sessions.resume")}
            </button>
          )}
          <button
            onClick={() => { setOpen(false); onDelete(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
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
    const trimmed = name.trim();
    if (!trimmed) return t("sessions.browserNameRequired");
    if (sessions.some((s) => s.name?.toLowerCase() === trimmed.toLowerCase()))
      return t("sessions.browserNameDuplicate");
    return "";
  }

  function handleCreate() {
    const trimmed = newSessionName.trim();
    const err = getNameValidationError(trimmed);
    if (err) { setCreateError(err); return; }
    setCreateError("");
    createMutation.mutate(trimmed);
    setNewSessionName("");
  }

  const nameError = newSessionName ? getNameValidationError(newSessionName) : "";
  const canCreate = !createMutation.isPending && !getNameValidationError(newSessionName);

  // Filter + paginate
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
    <div className="mx-auto w-full max-w-screen-2xl px-4 pt-5 pb-12">
      {/* Filters + actions */}
      <div className="flex items-center justify-between mb-4 px-2">
        <StatusFilterDropdown value={statusFilter} onChange={setStatusFilter} />
        <button
          onClick={() => setNewBrowserModalOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1dc99a] text-white text-[13px] font-medium rounded-sm hover:bg-[#17a87f] transition-colors"
        >
          <Plus size={13} />
          {t("sessions.newBrowser")}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-[#edebeb]">
        {isPending && sessions.length === 0 ? (
          <div className="flex justify-center py-16">
            <Loader2 size={20} className="animate-spin text-[#cac8c7]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2">
            <div className="w-10 h-10 rounded-md bg-[#fafafa] flex items-center justify-center">
              <Globe size={18} className="text-[#cac8c7]" />
            </div>
            <p className="text-[13px] text-[#969493]">{t("sessions.noBrowsers")}</p>
          </div>
        ) : (
          <>
            <table className="text-[#260f17] text-[13px] w-full border-separate border-spacing-0 table-auto">
              <thead>
                <tr>
                  <th className="text-[#969493] text-xs px-2 py-3 text-left font-normal w-[10%]">
                    {t("browsers.filterStatus")}
                  </th>
                  <th className="text-[#969493] text-xs px-2 py-3 text-left font-normal w-[20%]">
                    {t("browsers.browserId")}
                  </th>
                  <th className="text-[#969493] text-xs px-2 py-3 text-left font-normal">
                    {t("browsers.name")}
                  </th>
                  <th className="text-[#969493] text-xs px-2 py-3 text-left font-normal w-[22%]">
                    {t("browsers.started")}
                  </th>
                  <th className="text-[#969493] text-xs px-2 py-3 text-left font-normal w-[22%]">
                    {t("browsers.lastActive")}
                  </th>
                  <th className="text-[#969493] text-xs px-2 py-3 text-left font-normal w-[18%]">
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
                      "border-t border-[#edebeb] transition-colors",
                      session.status === "running" && "hover:bg-[#fafafa] cursor-pointer"
                    )}
                    onClick={() =>
                      session.status === "running" &&
                      window.open(`/sessions/${session.id}`, "_blank")
                    }
                  >
                    <td className="p-0">
                      <div className="flex h-12 items-center px-2">
                        <StatusBadge status={session.status} />
                      </div>
                    </td>
                    <td className="p-0">
                      <div className="flex h-12 items-center px-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="font-mono text-[#260f17]">{session.id.slice(0, 8)}…</span>
                          <CopyButton value={session.id} />
                        </span>
                      </div>
                    </td>
                    <td className="p-0">
                      <div className="flex h-12 items-center px-2">
                        {session.name
                          ? <span>{session.name}</span>
                          : <span className="text-[#cac8c7]">—</span>}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-2 text-[#514f4f]">
                        {formatDateTime(session.createdAt)}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-2 text-[#514f4f]">
                        {formatDateTime(session.lastActiveAt)}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-2">
                        {(() => {
                          const days = daysUntilExpiry(session.expiresAt);
                          if (days === null) return <span className="text-[#cac8c7]">—</span>;
                          if (days <= 0) return <span className="text-red-500 text-[13px] font-medium">Expired</span>;
                          if (days <= 7) return <span className="text-red-500 text-[13px]">{formatDateTime(session.expiresAt!)}</span>;
                          if (days <= EXPIRY_WARNING_DAYS) return <span className="text-amber-600 text-[13px]">{formatDateTime(session.expiresAt!)}</span>;
                          return <span className="text-[#514f4f] text-[13px]">{formatDateTime(session.expiresAt!)}</span>;
                        })()}
                      </div>
                    </td>
                    <td className="p-0">
                      <div className="flex h-12 items-center justify-end px-2" onClick={(e) => e.stopPropagation()}>
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
            <div className="px-4 py-3 flex items-center justify-between border-t border-[#edebeb]">
              <span className="text-xs text-[#969493]">
                {t("browsers.viewing", { from, to, total: filtered.length })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-xs text-[#514f4f] border border-[#edebeb] rounded-sm hover:bg-[#fafafa] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {t("browsers.previous")}
                </button>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 text-xs text-[#514f4f] border border-[#edebeb] rounded-sm hover:bg-[#fafafa] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
          className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => {
            setNewBrowserModalOpen(false);
            setNewSessionName("");
            setCreateError("");
          }}
        >
          <div
            className="bg-white rounded-lg shadow-2xl border border-[#edebeb] p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[#260f17] mb-4">
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
              autoFocus
              className={clsx(
                "w-full px-3.5 py-2.5 bg-[#fafafa] border rounded-md text-sm text-[#260f17] placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-colors",
                nameError
                  ? "border-red-200 focus:ring-red-400/20"
                  : "border-[#edebeb] focus:ring-gray-900/10"
              )}
              disabled={createMutation.isPending}
            />
            {(nameError || (createError && !nameError)) && (
              <p className="mt-1.5 text-xs text-red-500">{nameError || createError}</p>
            )}
            {createMutation.isPending && (
              <p className="mt-1.5 text-xs text-[#969493]">{t("sessions.startingHint")}</p>
            )}
            <div className="flex gap-2 justify-end mt-4">
              <button
                onClick={() => {
                  setNewBrowserModalOpen(false);
                  setNewSessionName("");
                  setCreateError("");
                }}
                className="px-3.5 py-2 text-xs font-medium text-[#514f4f] bg-[#f6f5f5] hover:bg-[#edebeb] rounded-md transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                className="px-3.5 py-2 text-xs font-medium text-white bg-[#1dc99a] hover:bg-[#17a87f] rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
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
          className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setDeleteConfirmModalId(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl border border-[#edebeb] p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[#260f17] mb-1">
              {t("sessions.deleteBrowserTitle")}
            </h3>
            <p className="text-xs text-[#969493] mb-5">{t("sessions.deleteBrowserHint")}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirmModalId(null)}
                className="px-3.5 py-2 text-xs font-medium text-[#514f4f] bg-[#f6f5f5] hover:bg-[#edebeb] rounded-md transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirmModalId)}
                disabled={deleteMutation.isPending}
                className="px-3.5 py-2 text-xs font-medium text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
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
