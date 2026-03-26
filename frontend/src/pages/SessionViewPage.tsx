import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { sessionsApi, Session, SteelSessionDetails } from "../api/client.ts";
import { Loader2, AlertCircle, Monitor, RefreshCw, Maximize2 } from "lucide-react";
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

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ─── Log Types ────────────────────────────────────────────────────────────────

interface LogEntry {
  id: string;
  timestamp: string;
  type: "Console" | "Request" | "Response" | "Error" | "Navigation";
  text: string;
  payload?: Record<string, unknown>;
}

interface RawLogEvent {
  id?: string;
  timestamp?: string;
  type?: LogEntry["type"];
  pageId?: string;
  targetType?: string;
  console?: {
    level?: string;
    text?: string;
    loc?: string;
  };
  request?: {
    method?: string;
    url?: string;
    resourceType?: string;
  };
  response?: {
    status?: number;
    url?: string;
    mimeType?: string;
  };
  error?: {
    message?: string;
  };
  navigation?: {
    url?: string;
  };
}

const LOG_TYPE_COLOR: Record<string, string> = {
  Console:    "text-cyan-400",
  Request:    "text-pink-400",
  Response:   "text-emerald-400",
  Error:      "text-red-400",
  Navigation: "text-gray-500",
};

function formatLogMessage(log: LogEntry): string {
  const body = log.payload;
  if (!body) return log.text;

  if (log.type === "Console") {
    const consolePayload = body.console as Record<string, unknown> | undefined;
    const msg = typeof consolePayload?.text === "string" ? consolePayload.text : "";
    return msg.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+(INFO|WARN|ERROR|DEBUG)\s+/, "").replace(/\n|\t/g, " ");
  }

  if (log.type === "Request") {
    const requestPayload = body.request as Record<string, unknown> | undefined;
    const method = typeof requestPayload?.method === "string" ? requestPayload.method : "REQUEST";
    const url = typeof requestPayload?.url === "string" ? requestPayload.url : "";
    return url ? `[${method}] ${url}` : log.text;
  }

  if (log.type === "Response") {
    const responsePayload = body.response as Record<string, unknown> | undefined;
    const status = typeof responsePayload?.status === "number" ? responsePayload.status : "?";
    const url = typeof responsePayload?.url === "string" ? responsePayload.url : "";
    return url ? `[${status}] ${url}` : log.text;
  }

  if (log.type === "Error") {
    const errorPayload = body.error as Record<string, unknown> | undefined;
    return typeof errorPayload?.message === "string" ? errorPayload.message : log.text;
  }

  if (log.type === "Navigation") {
    const navigationPayload = body.navigation as Record<string, unknown> | undefined;
    return typeof navigationPayload?.url === "string" ? navigationPayload.url : log.text;
  }

  return log.text;
}

function stringifyPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function normalizeIncomingLogs(data: string): LogEntry[] {
  const parsed = JSON.parse(data) as unknown;
  const rawLogs = Array.isArray(parsed) ? parsed as RawLogEvent[] : [parsed as RawLogEvent];

  return rawLogs
    .filter((log): log is RawLogEvent & { type: LogEntry["type"]; timestamp: string } =>
      Boolean(log && log.type && log.timestamp)
    )
    .map((log, index) => ({
      id: log.id ?? `${log.timestamp}-${log.type}-${log.pageId ?? "page"}-${index}`,
      timestamp: log.timestamp,
      type: log.type,
      text: stringifyPayload(log),
      payload: log as unknown as Record<string, unknown>,
    }));
}

// ─── Sidebar Tabs ─────────────────────────────────────────────────────────────

type SidebarTab = "details" | "logs" | "devtools";

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-gray-800">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={clsx("text-xs text-gray-300 break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

function DetailsSidebar({ session, sessionToken }: { session: Session; sessionToken: string | null }) {
  const [details, setDetails] = useState<SteelSessionDetails | null>(null);

  useEffect(() => {
    if (!sessionToken) return;
    sessionsApi.getDetails(session.id, sessionToken)
      .then((r) => setDetails(r.data))
      .catch(() => {});
    // Refresh every 5s while running
    const interval = setInterval(() => {
      sessionsApi.getDetails(session.id, sessionToken)
        .then((r) => setDetails(r.data))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [session.id, sessionToken]);

  return (
    <div className="overflow-y-auto flex-1 px-3 pb-4 font-mono text-xs">
      <DetailRow label="ID" value={session.id} mono />
      <DetailRow label="Name" value={session.name ?? "—"} />
      <DetailRow label="Created" value={formatDate(session.createdAt)} />
      <DetailRow label="Last Active" value={formatDate(session.lastActiveAt)} />
      {session.containerName && (
        <DetailRow label="Container" value={session.containerName} mono />
      )}
      {details?.duration !== undefined && (
        <DetailRow label="Duration" value={formatDuration(details.duration)} />
      )}
      {details?.userAgent && (
        <DetailRow label="User Agent" value={details.userAgent} />
      )}
      {details?.isSelenium !== undefined && (
        <DetailRow label="isSelenium" value={String(details.isSelenium)} />
      )}
      {details?.solveCaptcha !== undefined && (
        <DetailRow label="Auto-captcha" value={String(details.solveCaptcha)} />
      )}
      {details?.proxy !== undefined && (
        <DetailRow label="Proxy" value={details.proxy || "None"} />
      )}
      {details?.proxyTxBytes !== undefined && (
        <DetailRow label="Proxy TX" value={formatBytes(details.proxyTxBytes)} />
      )}
      {details?.proxyRxBytes !== undefined && (
        <DetailRow label="Proxy RX" value={formatBytes(details.proxyRxBytes)} />
      )}
      {details?.creditsUsed !== undefined && (
        <DetailRow label="Cost" value={String(details.creditsUsed)} />
      )}
      {details?.websocketUrl && (
        <DetailRow label="WebSocket URL" value={details.websocketUrl} mono />
      )}
    </div>
  );
}

function DevToolsSidebar({ sessionId, sessionToken }: { sessionId: string; sessionToken: string | null }) {
  const [pageId, setPageId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionToken) return;

    const ws = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/sessions/${sessionId}/cast?token=${sessionToken}&tabInfo=true`
    );

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as
          | { type?: string; firstTabId?: string; pageId?: string }
          | { type?: string; firstTabId?: string; pageId?: string }[];
        const messages = Array.isArray(payload) ? payload : [payload];

        for (const message of messages) {
          if (message.type === "tabList" && message.firstTabId) {
            setPageId((prev) => prev ?? message.firstTabId ?? null);
          }
          if (message.type === "activeTabChange" && message.pageId) {
            setPageId(message.pageId);
          }
        }
      } catch {}
    };

    return () => ws.close();
  }, [sessionId, sessionToken]);

  if (!sessionToken) {
    return (
      <div className="flex-1 px-3 py-4 text-xs text-gray-500">
        DevTools will be available once the session token is ready.
      </div>
    );
  }

  const devtoolsWs = pageId
    ? `//${window.location.host}/ws/sessions/${sessionId}/cdp/devtools/page/${encodeURIComponent(pageId)}?token=${encodeURIComponent(sessionToken)}`
    : `//${window.location.host}/ws/sessions/${sessionId}/cdp?token=${encodeURIComponent(sessionToken)}`;
  const devtoolsSrc =
    `/api/sessions/${sessionId}/devtools/devtools_app.html` +
    `?token=${encodeURIComponent(sessionToken)}` +
    `&ws=${encodeURIComponent(devtoolsWs)}` +
    (pageId ? `&pageId=${encodeURIComponent(pageId)}` : "");

  return (
    <iframe
      src={devtoolsSrc}
      className="w-full h-full border-0 bg-white"
      title="Chrome DevTools"
      key={pageId ?? "default"}
    />
  );
}

function LogsSidebar({ sessionId, sessionToken }: { sessionId: string; sessionToken: string | null }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionToken) return;
    const ws = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/sessions/${sessionId}/logs?token=${sessionToken}`
    );
    ws.onmessage = (e) => {
      try {
        const incoming = normalizeIncomingLogs(e.data as string);
        setLogs((prev) =>
          [...prev, ...incoming]
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            .slice(-200)
        );
      } catch {}
    };
    return () => ws.close();
  }, [sessionId, sessionToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="overflow-y-auto flex-1 px-2 pb-2 font-mono text-xs">
      {logs.length === 0 && (
        <p className="text-gray-600 p-2">No logs yet…</p>
      )}
      {logs.map((log) => (
        <pre key={log.id} className="mb-1 whitespace-pre-wrap break-all leading-relaxed">
          <span className="text-gray-600">
            {new Date(log.timestamp).toLocaleTimeString("en-US", {
              hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
            })}
          </span>{" "}
          <span className={clsx(LOG_TYPE_COLOR[log.type] ?? "text-gray-400")}>
            [{log.type}]
          </span>{" "}
          <span className="text-gray-300">{formatLogMessage(log)}</span>
        </pre>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SessionViewPage() {
  const { id } = useParams<{ id: string }>();
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [activeTab, setActiveTab] = useState<SidebarTab>("details");
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <Loader2 size={22} className="animate-spin text-gray-300" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 gap-3">
        <p className="text-sm text-gray-400">Browser not found</p>
        <Link to="/sessions" className="text-sm text-gray-700 font-medium hover:text-gray-900 transition-colors">
          ← Back to browsers
        </Link>
      </div>
    );
  }

  const browserSrc = sessionToken
    ? `/api/sessions/${id}/browser?token=${sessionToken}`
    : null;

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <div className="w-6 h-6 bg-gray-700 rounded-lg flex items-center justify-center shrink-0">
          <Monitor size={13} className="text-gray-300" />
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-gray-100 truncate leading-tight">
            {session.name ?? "Unnamed browser"}
          </h1>
          <p className="text-xs text-gray-500 truncate font-mono">{session.id}</p>
        </div>

        <span
          className={clsx(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0",
            STATUS_STYLES[session.status]
          )}
        >
          <span className={clsx("w-1.5 h-1.5 rounded-full", STATUS_DOT[session.status])} />
          {session.status}
        </span>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Browser viewport */}
        <div className="flex-1 bg-gray-950 relative">
          {session.status === "creating" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center">
                <Loader2 size={22} className="animate-spin text-gray-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-300">Starting cloud browser</p>
                <p className="text-xs text-gray-600 mt-1">This may take up to 30 seconds</p>
              </div>
            </div>
          )}

          {session.status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-red-950 rounded-2xl flex items-center justify-center">
                <AlertCircle size={22} className="text-red-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-300">Browser failed to start</p>
                <Link to="/sessions" className="text-xs text-gray-500 hover:text-gray-300 transition-colors mt-1 block">
                  ← Back to browsers
                </Link>
              </div>
            </div>
          )}

          {session.status === "running" && tokenError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-amber-950 rounded-2xl flex items-center justify-center">
                <AlertCircle size={22} className="text-amber-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-300">{tokenError}</p>
                <button
                  onClick={() => {
                    setTokenError("");
                    sessionsApi
                      .getToken(id!)
                      .then((res) => setSessionToken(res.data.token))
                      .catch(() => setTokenError("Failed to get session access token"));
                  }}
                  className="inline-flex items-center gap-1.5 mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <RefreshCw size={11} />
                  Retry
                </button>
              </div>
            </div>
          )}

          {session.status === "running" && !tokenError && !sessionToken && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={22} className="animate-spin text-gray-600" />
            </div>
          )}

          {browserSrc && (
            <iframe
              ref={iframeRef}
              src={browserSrc}
              className="w-full h-full border-0"
              title="Cloud Browser"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}

          {/* Fullscreen button */}
          {browserSrc && (
            <button
              onClick={() => iframeRef.current?.requestFullscreen()}
              className="absolute bottom-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg bg-gray-900/70 hover:bg-gray-900 text-gray-400 hover:text-gray-100 backdrop-blur-sm transition-colors"
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>

        {/* Sidebar */}
        <aside className="w-96 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
          {/* Tabs */}
          <div className="flex border-b border-gray-800 shrink-0">
            {(["details", "logs", "devtools"] as SidebarTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={clsx(
                  "flex-1 py-2.5 text-xs font-medium capitalize transition-colors",
                  activeTab === tab
                    ? "text-gray-100 border-b-2 border-gray-100"
                    : "text-gray-500 hover:text-gray-400"
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {activeTab === "details" && (
            <DetailsSidebar session={session} sessionToken={sessionToken} />
          )}
          {activeTab === "logs" && (
            <LogsSidebar sessionId={session.id} sessionToken={sessionToken} />
          )}
          {activeTab === "devtools" && (
            <DevToolsSidebar sessionId={session.id} sessionToken={sessionToken} />
          )}
        </aside>
      </div>
    </div>
  );
}
