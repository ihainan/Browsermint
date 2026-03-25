import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { sessionsApi, Session } from "../api/client.ts";
import { ArrowLeft, Loader2, AlertCircle, Monitor } from "lucide-react";
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

export default function SessionViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState("");

  const { data: sessionData, isPending } = useQuery({
    queryKey: ["session", id],
    queryFn: () => sessionsApi.get(id!).then((r) => r.data.session),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "creating" || status === "stopping" ? 2000 : 10000;
    },
    enabled: !!id,
  });

  const session = sessionData;

  // Fetch session token once session is running
  useEffect(() => {
    if (!id || session?.status !== "running") return;
    setTokenError("");
    sessionsApi
      .getToken(id)
      .then((res) => setSessionToken(res.data.token))
      .catch(() => setTokenError("Failed to get session access token"));
  }, [id, session?.status]);

  if (isPending) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-gray-500">Session not found</p>
        <Link to="/sessions" className="text-sm text-gray-900 underline">
          Back to sessions
        </Link>
      </div>
    );
  }

  const browserSrc = sessionToken
    ? `/api/sessions/${id}/browser?token=${sessionToken}`
    : null;

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-4 shrink-0">
        <button
          onClick={() => navigate("/sessions")}
          className="p-1.5 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft size={18} />
        </button>

        <Monitor size={18} className="text-gray-400" />

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-gray-900 truncate">
            {session.name ?? "Unnamed session"}
          </h1>
          <p className="text-xs text-gray-400 truncate">{session.id}</p>
        </div>

        <span
          className={clsx(
            "px-2 py-0.5 rounded-full text-xs font-medium shrink-0",
            STATUS_STYLES[session.status]
          )}
        >
          {session.status}
        </span>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Browser iframe */}
        <div className="flex-1 bg-gray-900 relative">
          {session.status === "creating" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
              <Loader2 size={32} className="animate-spin" />
              <p className="text-sm opacity-70">Starting browser session...</p>
            </div>
          )}

          {session.status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
              <AlertCircle size={32} className="text-red-400" />
              <p className="text-sm opacity-70">Session failed to start</p>
              <Link
                to="/sessions"
                className="text-sm text-red-300 underline"
              >
                Back to sessions
              </Link>
            </div>
          )}

          {session.status === "running" && tokenError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
              <AlertCircle size={32} className="text-yellow-400" />
              <p className="text-sm opacity-70">{tokenError}</p>
              <button
                onClick={() => {
                  setTokenError("");
                  sessionsApi
                    .getToken(id!)
                    .then((res) => setSessionToken(res.data.token))
                    .catch(() => setTokenError("Failed to get session access token"));
                }}
                className="text-sm text-yellow-300 underline"
              >
                Retry
              </button>
            </div>
          )}

          {session.status === "running" && !tokenError && !sessionToken && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={24} className="animate-spin text-gray-500" />
            </div>
          )}

          {browserSrc && (
            <iframe
              src={browserSrc}
              className="w-full h-full border-0"
              title="Browser session"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}
        </div>

        {/* Session info sidebar */}
        <aside className="w-64 bg-white border-l border-gray-200 p-4 shrink-0 overflow-y-auto">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Session info
          </h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gray-400">Name</dt>
              <dd className="text-sm text-gray-900 truncate">
                {session.name ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-400">Status</dt>
              <dd className="text-sm text-gray-900">{session.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-400">Created</dt>
              <dd className="text-sm text-gray-900">
                {formatDate(session.createdAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-400">Last active</dt>
              <dd className="text-sm text-gray-900">
                {formatDate(session.lastActiveAt)}
              </dd>
            </div>
            {session.containerName && (
              <div>
                <dt className="text-xs text-gray-400">Container</dt>
                <dd className="text-xs text-gray-500 font-mono truncate">
                  {session.containerName}
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
    </div>
  );
}
