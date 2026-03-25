import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionsApi, Session } from "../api/client.ts";
import { useAuth } from "../contexts/AuthContext.tsx";
import { Plus, Trash2, Monitor, LogOut, Loader2, ExternalLink, Globe } from "lucide-react";
import clsx from "clsx";

const STATUS_STYLES: Record<Session["status"], string> = {
  creating: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  running:  "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  stopping: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  stopped:  "bg-gray-100 text-gray-500 ring-1 ring-gray-200",
  error:    "bg-red-50 text-red-600 ring-1 ring-red-200",
};

const STATUS_DOT: Record<Session["status"], string> = {
  creating: "bg-amber-400 animate-pulse",
  running:  "bg-emerald-500",
  stopping: "bg-orange-400 animate-pulse",
  stopped:  "bg-gray-400",
  error:    "bg-red-500",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

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
  const queryClient = useQueryClient();
  const [newSessionName, setNewSessionName] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
      window.open(`/sessions/${res.data.session.id}`, "_blank");
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? "Failed to create browser";
      setCreateError(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setDeleteConfirmId(null);
    },
  });

  function getNameValidationError(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "Browser name is required";
    const duplicate = sessions.some(
      (s) => s.name?.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) return "You already have a browser with this name";
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
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm px-6 py-3.5 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center">
            <Monitor size={14} className="text-white" />
          </div>
          <h1 className="text-base font-bold text-gray-900 tracking-tight">SteelYard</h1>
        </div>

        <div ref={avatarRef} className="relative">
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
            <div className="absolute right-0 mt-2.5 w-52 bg-white rounded-2xl shadow-xl shadow-gray-200/60 border border-gray-100 py-1.5 z-20">
              <div className="px-4 py-2.5 mb-1">
                <p className="text-sm font-semibold text-gray-900">{user?.username}</p>
                <p className="text-xs text-gray-400 truncate mt-0.5">{user?.email}</p>
              </div>
              <div className="h-px bg-gray-100 mx-2 mb-1" />
              <button
                onClick={() => { setAvatarOpen(false); logout(); }}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-xl mx-auto transition-colors"
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Create session */}
        <div className="bg-white rounded-2xl shadow-md shadow-gray-300/50 border border-gray-200 p-6 mb-6">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
            New browser
          </h2>
          <div className="flex gap-3 items-start">
            <div className="flex-1">
              <input
                type="text"
                value={newSessionName}
                onChange={(e) => { setNewSessionName(e.target.value); setCreateError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Browser name"
                className={clsx(
                  "w-full px-3.5 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-colors",
                  nameError
                    ? "border-red-200 focus:ring-red-400/20"
                    : "border-gray-200 focus:ring-gray-900/10"
                )}
                disabled={createMutation.isPending}
              />
              {(nameError || (createError && !nameError)) && (
                <p className="mt-1.5 text-xs text-red-500">
                  {nameError || createError}
                </p>
              )}
              {createMutation.isPending && (
                <p className="mt-1.5 text-xs text-gray-400">
                  Starting cloud browser, this may take up to 30 seconds…
                </p>
              )}
            </div>
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-xl hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm shrink-0"
            >
              {createMutation.isPending ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Plus size={15} />
              )}
              {createMutation.isPending ? "Starting…" : "Create"}
            </button>
          </div>
        </div>

        {/* Sessions list */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Cloud Browsers
            </h2>
            {sessions.length > 0 && (
              <span className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">
                {sessions.length} / {user?.maxSessions ?? 5}
              </span>
            )}
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
              <p className="text-sm font-medium text-gray-400">No browsers yet</p>
              <p className="text-xs text-gray-300 mt-1">Create one above to get started</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="group bg-white rounded-2xl border border-gray-200 shadow-md shadow-gray-300/40 px-5 py-4 flex items-center gap-4 hover:shadow-lg hover:shadow-gray-300/50 hover:border-gray-300 transition-all duration-150"
                >
                  {/* Icon */}
                  <div className={clsx(
                    "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-gradient-to-br shadow-sm",
                    getBrowserGradient(session.name)
                  )}>
                    <Globe size={17} className="text-white drop-shadow-sm" />
                  </div>

                  {/* Name + ID */}
                  <div
                    className={clsx(
                      "min-w-0 w-48 shrink-0",
                      session.status === "running" && "cursor-pointer"
                    )}
                    onClick={() =>
                      session.status === "running" &&
                      window.open(`/sessions/${session.id}`, "_blank")
                    }
                  >
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {session.name ?? "Unnamed browser"}
                      </p>
                      {session.status === "running" && (
                        <ExternalLink size={11} className="text-gray-300 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>
                    <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">
                      {session.id.slice(0, 8)}…
                    </p>
                  </div>

                  {/* Metadata columns */}
                  <div className="flex-1 grid grid-cols-3 gap-4 min-w-0">
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">Created</p>
                      <p className="text-xs text-gray-700 truncate">{formatDate(session.createdAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">Last active</p>
                      <p className="text-xs text-gray-700 truncate">{formatDate(session.lastActiveAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">Container</p>
                      <p className="text-xs text-gray-500 font-mono truncate">
                        {session.containerName
                          ? session.containerName.replace("steelyard-session-", "")
                          : "—"}
                      </p>
                    </div>
                  </div>

                  {/* Status + actions */}
                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={clsx(
                        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                        STATUS_STYLES[session.status]
                      )}
                    >
                      <span className={clsx("w-1.5 h-1.5 rounded-full", STATUS_DOT[session.status])} />
                      {session.status}
                    </span>

                    {deleteConfirmId === session.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => deleteMutation.mutate(session.id)}
                          disabled={deleteMutation.isPending}
                          className="text-xs text-red-500 font-semibold hover:text-red-600 transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirmId(session.id)}
                        className="p-1.5 text-gray-300 hover:text-red-400 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete browser"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
