import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionsApi, Session } from "../api/client.ts";
import { useAuth } from "../contexts/AuthContext.tsx";
import { Plus, Trash2, Monitor, LogOut, Loader2 } from "lucide-react";
import clsx from "clsx";

const STATUS_STYLES: Record<Session["status"], string> = {
  creating: "bg-yellow-100 text-yellow-800",
  running: "bg-green-100 text-green-800",
  stopping: "bg-orange-100 text-orange-800",
  stopped: "bg-gray-100 text-gray-600",
  error: "bg-red-100 text-red-700",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export default function SessionsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newSessionName, setNewSessionName] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");

  const { data, isPending: isLoadingSessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list().then((r) => r.data.sessions),
    refetchInterval: 5000,
  });

  const sessions = data ?? [];

  const createMutation = useMutation({
    mutationFn: (name: string) => sessionsApi.create({ name: name || undefined }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/sessions/${res.data.session.id}`);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? "Failed to create session";
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

  function handleCreate() {
    setCreateError("");
    createMutation.mutate(newSessionName.trim());
    setNewSessionName("");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">SteelYard</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user?.username}</span>
          <button
            onClick={logout}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Create session */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">New session</h2>
          <div className="flex gap-3">
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Session name (optional)"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
              disabled={createMutation.isPending}
            />
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {createMutation.isPending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              {createMutation.isPending ? "Starting..." : "New session"}
            </button>
          </div>
          {createError && (
            <p className="mt-2 text-sm text-red-600">{createError}</p>
          )}
          {createMutation.isPending && (
            <p className="mt-2 text-sm text-gray-500">
              Starting browser session, this may take up to 30 seconds...
            </p>
          )}
        </div>

        {/* Sessions list */}
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            Sessions
            {sessions.length > 0 && (
              <span className="ml-2 text-gray-400 font-normal">
                ({sessions.length} / {user?.maxSessions ?? 5})
              </span>
            )}
          </h2>

          {isLoadingSessions && sessions.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Monitor size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">No sessions yet. Create one to get started.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between hover:border-gray-300 transition-colors"
                >
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() =>
                      session.status === "running" &&
                      navigate(`/sessions/${session.id}`)
                    }
                  >
                    <div className="flex items-center gap-3">
                      <Monitor size={18} className="text-gray-400 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {session.name ?? "Unnamed session"}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          Created {formatDate(session.createdAt)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 ml-4">
                    <span
                      className={clsx(
                        "px-2 py-0.5 rounded-full text-xs font-medium",
                        STATUS_STYLES[session.status]
                      )}
                    >
                      {session.status === "creating" && (
                        <Loader2 size={10} className="inline animate-spin mr-1" />
                      )}
                      {session.status}
                    </span>

                    {deleteConfirmId === session.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => deleteMutation.mutate(session.id)}
                          disabled={deleteMutation.isPending}
                          className="text-xs text-red-600 font-medium hover:underline"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          className="text-xs text-gray-500 hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirmId(session.id)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete session"
                      >
                        <Trash2 size={16} />
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
