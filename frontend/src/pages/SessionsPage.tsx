import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionsApi, Session } from "../api/client.ts";
import { useAuth } from "../contexts/AuthContext.tsx";
import { Plus, Trash2, Monitor, LogOut, Loader2, ExternalLink, Globe, Play, Pause, MoreHorizontal, ChevronRight, Check } from "lucide-react";
import clsx from "clsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { getSessionStatusLabel } from "../i18n/sessionStatus.ts";


const BROWSER_GRADIENTS = [
  "from-sky-400 to-blue-500",
  "from-violet-400 to-purple-500",
  "from-emerald-400 to-teal-500",
  "from-rose-400 to-pink-500",
  "from-amber-400 to-orange-500",
  "from-cyan-400 to-sky-500",
  "from-indigo-400 to-violet-500",
  "from-green-400 to-emerald-500",
];

function getBrowserGradient(name: string | null): string {
  const seed = (name ?? "").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return BROWSER_GRADIENTS[seed % BROWSER_GRADIENTS.length];
}

const AVATAR_COLORS = [
  "bg-red-500", "bg-orange-500", "bg-amber-500", "bg-yellow-500",
  "bg-lime-600", "bg-green-500", "bg-teal-500", "bg-cyan-500",
  "bg-sky-500", "bg-blue-500", "bg-indigo-500", "bg-violet-500",
  "bg-purple-500", "bg-fuchsia-500", "bg-pink-500", "bg-rose-500",
];

function getAvatarColor(username: string): string {
  const hash = username.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export default function SessionsPage() {
  const { user, logout } = useAuth();
  const { locale, setLocale, t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const [newSessionName, setNewSessionName] = useState("");
  const [deleteConfirmModalId, setDeleteConfirmModalId] = useState<string | null>(null);
  const [openMoreMenuId, setOpenMoreMenuId] = useState<string | null>(null);
  const [newBrowserModalOpen, setNewBrowserModalOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarOpen(false);
        setLanguageMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!openMoreMenuId) return;
    function handleClick() {
      setOpenMoreMenuId(null);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [openMoreMenuId]);

  const { data, isPending: isLoadingSessions } = useQuery({
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
    onSuccess: (_, id) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.filter((s) => s.id !== id)
      );
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setDeleteConfirmModalId(null);
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.stop(id),
    onMutate: (id) => {
      // Optimistic update: immediately show "stopping" so the card reflects the action
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => s.id === id ? { ...s, status: "stopping" as const } : s)
      );
    },
    onSuccess: (res) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => s.id === res.data.session.id ? res.data.session : s)
      );
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.start(id),
    onMutate: (id) => {
      // Optimistic update: immediately show "creating" so the card reflects the action
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => s.id === id ? { ...s, status: "creating" as const } : s)
      );
    },
    onSuccess: (res) => {
      queryClient.setQueryData<Session[]>(["sessions"], (old) =>
        old?.map((s) => s.id === res.data.session.id ? res.data.session : s)
      );
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  function getNameValidationError(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return t("sessions.browserNameRequired");
    const duplicate = sessions.some((s) => s.name?.toLowerCase() === trimmed.toLowerCase());
    if (duplicate) return t("sessions.browserNameDuplicate");
    return "";
  }

  function handleCreate() {
    const trimmed = newSessionName.trim();
    const validationError = getNameValidationError(trimmed);
    if (validationError) {
      setCreateError(validationError);
      return;
    }
    setCreateError("");
    createMutation.mutate(trimmed);
    setNewSessionName("");
  }

  const nameError = newSessionName ? getNameValidationError(newSessionName) : "";
  const canCreate = !createMutation.isPending && !getNameValidationError(newSessionName);

  const avatarColor = getAvatarColor(user?.username ?? "");
  const avatarInitial = (user?.username?.[0] ?? "?").toUpperCase();

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-white border-b border-gray-200 shadow-sm px-6 py-3.5 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center">
            <Monitor size={14} className="text-white" />
          </div>
          <h1 className="text-base font-bold text-gray-900 tracking-tight">Browsermint</h1>
        </div>

        <div
          ref={avatarRef}
          className="relative"
          onMouseEnter={() => setAvatarOpen(true)}
          onMouseLeave={() => {
            setAvatarOpen(false);
            setLanguageMenuOpen(false);
          }}
        >
          <button
            onClick={() => setAvatarOpen((o) => !o)}
            className={clsx(
              "w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold focus:outline-none ring-2 ring-offset-1 ring-transparent hover:ring-gray-300 transition-all",
              avatarColor
            )}
            title={user?.username}
          >
            {avatarInitial}
          </button>

          {avatarOpen && (
            <div className="absolute right-0 top-full pt-2.5 z-20">
              <div className="absolute inset-x-0 -top-2.5 h-2.5" />
              <div className="w-52 bg-white rounded-2xl shadow-xl shadow-gray-200/60 border border-gray-100 py-1.5">
                <div className="px-4 py-2.5 mb-1">
                  <p className="text-sm font-semibold text-gray-900">{user?.username}</p>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{user?.email}</p>
                </div>
                <div className="h-px bg-gray-100 mx-2 mb-1" />
                <div
                  className="relative mx-1"
                  onMouseEnter={() => setLanguageMenuOpen(true)}
                  onMouseLeave={() => setLanguageMenuOpen(false)}
                >
                  <button
                    onClick={() => setLanguageMenuOpen((open) => !open)}
                    className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-xl transition-colors"
                  >
                    <span>{t("common.language")}</span>
                    <ChevronRight size={14} />
                  </button>
                  {languageMenuOpen && (
                    <div className="absolute top-0 right-full min-w-36 bg-white rounded-2xl shadow-xl shadow-gray-200/60 border border-gray-100 py-1.5">
                      {(["zh", "en"] as const).map((nextLocale) => (
                        <button
                          key={nextLocale}
                          onClick={() => {
                            setLocale(nextLocale);
                            setLanguageMenuOpen(false);
                          }}
                          className="w-full flex items-center justify-between gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                        >
                          <span>{nextLocale === "zh" ? t("common.chinese") : t("common.english")}</span>
                          {locale === nextLocale && <Check size={14} className="text-gray-900" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    setAvatarOpen(false);
                    setLanguageMenuOpen(false);
                    logout();
                  }}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-xl mx-auto transition-colors"
                >
                  <LogOut size={14} />
                  {t("common.signOut")}
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {t("sessions.title")}
              {sessions.length > 0 && (
                <span className="ml-1.5 normal-case font-normal">
                  {t("sessions.count", { current: sessions.length, max: user?.maxSessions === 0 ? "∞" : (user?.maxSessions ?? 0) })}
                </span>
              )}
            </h2>
            <button
              onClick={() => setNewBrowserModalOpen(true)}
              disabled={!canCreate && user?.maxSessions !== 0 && sessions.length >= (user?.maxSessions ?? 0)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-xl hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Plus size={13} />
              {t("sessions.newBrowser")}
            </button>
          </div>

          {isLoadingSessions && sessions.length === 0 ? (
            <div className="flex justify-center py-16">
              <Loader2 size={22} className="animate-spin text-gray-300" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-16">
              <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Monitor size={24} className="text-gray-300" />
              </div>
              <p className="text-sm font-medium text-gray-400">{t("sessions.noBrowsers")}</p>
              <p className="text-xs text-gray-300 mt-1">{t("sessions.noBrowsersHint")}</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={clsx(
                    "group rounded-2xl border shadow-md px-5 py-4 flex items-center gap-4 hover:shadow-lg hover:border-gray-300 transition-all duration-150",
                    (session.status === "running" || session.status === "paused") && "cursor-pointer",
                    session.status === "stopped"
                      ? "bg-gray-50 border-gray-200 shadow-gray-200/40 hover:shadow-gray-200/50"
                      : "bg-white border-gray-200 shadow-gray-300/40 hover:shadow-gray-300/50"
                  )}
                  onClick={() => (session.status === "running" || session.status === "paused") && window.open(`/sessions/${session.id}`, "_blank")}
                >
                  <div
                    className={clsx(
                      "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-sm",
                      session.status === "stopped" || session.status === "stopping" || session.status === "paused"
                        ? "bg-gray-200"
                        : "bg-gradient-to-br " + getBrowserGradient(session.name)
                    )}
                  >
                    <Globe
                      size={17}
                      className={clsx(
                        "drop-shadow-sm",
                        session.status === "stopped" || session.status === "stopping" || session.status === "paused" ? "text-gray-400" : "text-white"
                      )}
                    />
                  </div>

                  <div
                    className="min-w-0 w-48 shrink-0"
                  >
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {session.name ?? t("common.unnamedBrowser")}
                      </p>
                      {(session.status === "running" || session.status === "paused") && (
                        <ExternalLink size={11} className="text-gray-300 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>
                    <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{session.id.slice(0, 8)}…</p>
                  </div>

                  <div className="flex-1 grid grid-cols-3 gap-4 min-w-0">
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">{t("sessions.created")}</p>
                      <p className="text-xs text-gray-700 truncate">{formatDateTime(session.createdAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">{t("sessions.lastActive")}</p>
                      <p className="text-xs text-gray-700 truncate">{formatDateTime(session.lastActiveAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">{t("sessions.container")}</p>
                      {session.status === "stopping" && (
                        <p className="text-xs text-orange-400 flex items-center gap-1">
                          <Loader2 size={10} className="animate-spin" />
                          {getSessionStatusLabel(locale, "stopping")}
                        </p>
                      )}
                      {session.status === "stopped" && (
                        <p className="text-xs text-gray-400 italic">{t("sessions.disabled")}</p>
                      )}
                      {session.status === "creating" && (
                        <p className="text-xs text-amber-500 flex items-center gap-1">
                          <Loader2 size={10} className="animate-spin" />
                          {getSessionStatusLabel(locale, "creating")}
                        </p>
                      )}
                      {session.status === "error" && (
                        <p className="text-xs text-red-500">{getSessionStatusLabel(locale, "error")}</p>
                      )}
                      {(session.status === "running" || session.status === "paused") && (
                        <p className="text-xs text-gray-500 font-mono truncate">
                          {session.containerName ? session.containerName.replace("browsermint-session-", "") : "—"}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMoreMenuId(openMoreMenuId === session.id ? null : session.id);
                        }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title={t("sessions.moreOptions")}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {openMoreMenuId === session.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-0 mt-1.5 w-40 bg-white rounded-xl shadow-lg shadow-gray-200/60 border border-gray-100 py-1 z-20"
                        >
                          {session.status === "running" && (
                            <button
                              onClick={() => {
                                setOpenMoreMenuId(null);
                                stopMutation.mutate(session.id);
                              }}
                              disabled={stopMutation.isPending && stopMutation.variables === session.id}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                            >
                              {stopMutation.isPending && stopMutation.variables === session.id
                                ? <Loader2 size={13} className="animate-spin" />
                                : <Pause size={13} />}
                              {t("sessions.disable")}
                            </button>
                          )}
                          {(session.status === "stopped" || session.status === "error") && (
                            <button
                              onClick={() => {
                                setOpenMoreMenuId(null);
                                startMutation.mutate(session.id);
                              }}
                              disabled={startMutation.isPending && startMutation.variables === session.id}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                            >
                              {startMutation.isPending && startMutation.variables === session.id
                                ? <Loader2 size={13} className="animate-spin" />
                                : <Play size={13} />}
                              {t("sessions.resume")}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setOpenMoreMenuId(null);
                              setDeleteConfirmModalId(session.id);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 size={13} />
                            {t("sessions.delete")}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

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
            className="bg-white rounded-2xl shadow-2xl border border-gray-100 p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-4">{t("sessions.newBrowserModalTitle")}</h3>
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
                "w-full px-3.5 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-colors",
                nameError ? "border-red-200 focus:ring-red-400/20" : "border-gray-200 focus:ring-gray-900/10"
              )}
              disabled={createMutation.isPending}
            />
            {(nameError || (createError && !nameError)) && (
              <p className="mt-1.5 text-xs text-red-500">{nameError || createError}</p>
            )}
            {createMutation.isPending && <p className="mt-1.5 text-xs text-gray-400">{t("sessions.startingHint")}</p>}
            <div className="flex gap-2 justify-end mt-4">
              <button
                onClick={() => {
                  setNewBrowserModalOpen(false);
                  setNewSessionName("");
                  setCreateError("");
                }}
                className="px-3.5 py-2 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                className="px-3.5 py-2 text-xs font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {createMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                {createMutation.isPending ? t("sessions.starting") : t("common.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmModalId && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setDeleteConfirmModalId(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-gray-100 p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-1">{t("sessions.deleteBrowserTitle")}</h3>
            <p className="text-xs text-gray-400 mb-5">{t("sessions.deleteBrowserHint")}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirmModalId(null)}
                className="px-3.5 py-2 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirmModalId)}
                disabled={deleteMutation.isPending}
                className="px-3.5 py-2 text-xs font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
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
