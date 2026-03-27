import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { sessionsApi, Session, SteelSessionDetails } from "../api/client.ts";
import { Loader2, AlertCircle, Monitor, RefreshCw, Maximize2, X, Copy, Check, Plug, ExternalLink } from "lucide-react";
import clsx from "clsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { getSessionStatusLabel } from "../i18n/sessionStatus.ts";

const STATUS_STYLES: Record<Session["status"], string> = {
  creating: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  running: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  stopping: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  stopped: "bg-gray-100 text-gray-500 ring-1 ring-gray-200",
  error: "bg-red-50 text-red-600 ring-1 ring-red-200",
};

const STATUS_DOT: Record<Session["status"], string> = {
  creating: "bg-amber-400 animate-pulse",
  running: "bg-emerald-500",
  stopping: "bg-orange-400 animate-pulse",
  stopped: "bg-gray-400",
  error: "bg-red-500",
};

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
  Console: "text-cyan-400",
  Request: "text-pink-400",
  Response: "text-emerald-400",
  Error: "text-red-400",
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
  const rawLogs = Array.isArray(parsed) ? (parsed as RawLogEvent[]) : [parsed as RawLogEvent];

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
  const { t, formatDateTime } = useI18n();
  const [details, setDetails] = useState<SteelSessionDetails | null>(null);

  useEffect(() => {
    if (!sessionToken) return;
    sessionsApi.getDetails(session.id, sessionToken).then((r) => setDetails(r.data)).catch(() => {});
    const interval = setInterval(() => {
      sessionsApi.getDetails(session.id, sessionToken).then((r) => setDetails(r.data)).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [session.id, sessionToken]);

  return (
    <div className="overflow-y-auto flex-1 px-3 pb-4 font-mono text-xs">
      <DetailRow label={t("sessionView.details.id")} value={session.id} mono />
      <DetailRow label={t("sessionView.details.name")} value={session.name ?? "—"} />
      <DetailRow label={t("sessionView.details.created")} value={formatDateTime(session.createdAt)} />
      <DetailRow label={t("sessionView.details.lastActive")} value={formatDateTime(session.lastActiveAt)} />
      {session.containerName && <DetailRow label={t("sessionView.details.container")} value={session.containerName} mono />}
      {details?.duration !== undefined && <DetailRow label={t("sessionView.details.duration")} value={formatDuration(details.duration)} />}
      {details?.userAgent && <DetailRow label={t("sessionView.details.userAgent")} value={details.userAgent} />}
      {details?.isSelenium !== undefined && <DetailRow label={t("sessionView.details.isSelenium")} value={String(details.isSelenium)} />}
      {details?.solveCaptcha !== undefined && <DetailRow label={t("sessionView.details.autoCaptcha")} value={String(details.solveCaptcha)} />}
      {details?.proxy !== undefined && <DetailRow label={t("sessionView.details.proxy")} value={details.proxy || t("sessionView.details.none")} />}
      {details?.proxyTxBytes !== undefined && <DetailRow label={t("sessionView.details.proxyTx")} value={formatBytes(details.proxyTxBytes)} />}
      {details?.proxyRxBytes !== undefined && <DetailRow label={t("sessionView.details.proxyRx")} value={formatBytes(details.proxyRxBytes)} />}
      {details?.creditsUsed !== undefined && <DetailRow label={t("sessionView.details.cost")} value={String(details.creditsUsed)} />}
      {details?.websocketUrl && <DetailRow label={t("sessionView.details.websocketUrl")} value={details.websocketUrl} mono />}
    </div>
  );
}

type AgentPlatform = "openclaw" | "claude-code" | "cursor" | "custom";

function usePlatformLabels() {
  const { t } = useI18n();
  return [
    { id: "openclaw" as const, label: "OpenClaw" },
    { id: "claude-code" as const, label: "Claude Code" },
    { id: "cursor" as const, label: "Cursor" },
    { id: "custom" as const, label: t("sessionView.connect.customApi") },
  ];
}

function CodeBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group mt-2">
      <pre className="bg-gray-950 text-gray-300 text-xs rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed border border-gray-800">
        {code}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors opacity-0 group-hover:opacity-100"
        title={t("sessionView.connect.copy")}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function PlatformContent({
  platform,
  cdpUrl,
  sessionId,
}: {
  platform: AgentPlatform;
  cdpUrl: string;
  sessionId: string;
}) {
  const { t } = useI18n();

  if (platform === "openclaw") {
    return (
      <div className="space-y-4 text-sm text-gray-300">
        <p>{t("sessionView.connect.openclawIntro")}</p>
        <div>
          <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.cdpLabel")}</p>
          <CodeBlock code={cdpUrl} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.openclawConfig")}</p>
          <CodeBlock code={`browser:\n  type: cdp\n  endpoint: "${cdpUrl}"`} />
        </div>
        <p className="text-xs text-gray-500">{t("sessionView.connect.openclawHint")}</p>
      </div>
    );
  }

  if (platform === "claude-code") {
    return (
      <div className="space-y-4 text-sm text-gray-300">
        <p>{t("sessionView.connect.claudeIntro")}</p>
        <div>
          <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.cdpLabel")}</p>
          <CodeBlock code={cdpUrl} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.claudeConfig")}</p>
          <CodeBlock
            code={`{\n  "mcpServers": {\n    "browser": {\n      "command": "npx",\n      "args": ["@playwright/mcp"],\n      "env": {\n        "CDP_ENDPOINT": "${cdpUrl}"\n      }\n    }\n  }\n}`}
          />
        </div>
        <p className="text-xs text-gray-500">{t("sessionView.connect.claudeHint")}</p>
      </div>
    );
  }

  if (platform === "cursor") {
    return (
      <div className="space-y-4 text-sm text-gray-300">
        <p>{t("sessionView.connect.cursorIntro")}</p>
        <div>
          <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.cdpLabel")}</p>
          <CodeBlock code={cdpUrl} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.cursorConfig")}</p>
          <CodeBlock
            code={`{\n  "mcpServers": {\n    "browser": {\n      "command": "npx",\n      "args": ["@playwright/mcp"],\n      "env": {\n        "CDP_ENDPOINT": "${cdpUrl}"\n      }\n    }\n  }\n}`}
          />
        </div>
        <p className="text-xs text-gray-500">{t("sessionView.connect.cursorHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm text-gray-300">
      <p>{t("sessionView.connect.customIntro")}</p>
      <div>
        <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.sessionIdLabel")}</p>
        <CodeBlock code={sessionId} />
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.cdpLabel")}</p>
        <CodeBlock code={cdpUrl} />
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.playwrightNode")}</p>
        <CodeBlock code={`import { chromium } from "playwright";\n\nconst browser = await chromium.connectOverCDP(\n  "${cdpUrl}"\n);`} />
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-1">{t("sessionView.connect.playwrightPython")}</p>
        <CodeBlock
          code={`from playwright.async_api import async_playwright\n\nasync with async_playwright() as p:\n    browser = await p.chromium.connect_over_cdp(\n        "${cdpUrl}"\n    )`}
        />
      </div>
    </div>
  );
}

function ConnectAgentModal({
  session,
  sessionToken,
  onClose,
}: {
  session: Session;
  sessionToken: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const platforms = usePlatformLabels();
  const [platform, setPlatform] = useState<AgentPlatform>("openclaw");
  const cdpUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/sessions/${session.id}/cdp?token=${sessionToken}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">{t("sessionView.connect.title")}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t("sessionView.connect.subtitle")}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-40 border-r border-gray-800 py-3 shrink-0">
            {platforms.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlatform(p.id)}
                className={clsx(
                  "w-full text-left px-4 py-2.5 text-xs font-medium transition-colors",
                  platform === p.id ? "text-gray-100 bg-gray-800" : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            <PlatformContent platform={platform} cdpUrl={cdpUrl} sessionId={session.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DevToolsSidebar({ sessionId, sessionToken }: { sessionId: string; sessionToken: string | null }) {
  const { t } = useI18n();
  const [devtoolsWsPath, setDevtoolsWsPath] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionToken) {
      setDevtoolsWsPath(null);
      setPageId(null);
      return;
    }

    const refreshTarget = () => {
      sessionsApi.getDevtoolsTarget(sessionId, sessionToken).then((res) => {
        setPageId(res.data.pageId);
        setDevtoolsWsPath(res.data.wsPath);
      }).catch(() => {});
    };

    refreshTarget();
    const interval = setInterval(refreshTarget, 5000);
    return () => clearInterval(interval);
  }, [sessionId, sessionToken]);

  useEffect(() => {
    if (!sessionToken) return;

    const ws = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/sessions/${sessionId}/pageId?token=${encodeURIComponent(sessionToken)}`
    );

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as { pageId?: string };
        if (payload.pageId) {
          setPageId(payload.pageId);
          sessionsApi.getDevtoolsTarget(sessionId, sessionToken).then((res) => {
            setPageId(res.data.pageId);
            setDevtoolsWsPath(res.data.wsPath);
          }).catch(() => {});
        }
      } catch {}
    };

    return () => ws.close();
  }, [sessionId, sessionToken]);

  const openDevTools = () => {
    if (!sessionToken || !devtoolsWsPath) return;
    const proxiedWs = `//${window.location.host}/ws/sessions/${sessionId}/cdp${devtoolsWsPath}?token=${encodeURIComponent(sessionToken)}`;
    const devtoolsSrc =
      `/api/sessions/${sessionId}/devtools/devtools_app.html` +
      `?token=${encodeURIComponent(sessionToken)}` +
      `&ws=${encodeURIComponent(proxiedWs)}` +
      (pageId ? `&pageId=${encodeURIComponent(pageId)}` : "");
    window.open(devtoolsSrc, `devtools-${sessionId}`, "width=1280,height=800,menubar=no,toolbar=no");
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
      <p className="text-xs text-gray-500 text-center leading-relaxed">{t("sessionView.devtools.intro")}</p>
      <button
        onClick={openDevTools}
        disabled={!sessionToken || !devtoolsWsPath}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-200 text-xs font-medium transition-colors"
      >
        <ExternalLink size={13} />
        {t("sessionView.devtools.open")}
      </button>
      <p className="text-xs text-gray-600 text-center">
        {devtoolsWsPath ? t("sessionView.devtools.ready") : t("sessionView.devtools.waiting")}
      </p>
    </div>
  );
}

function LogsSidebar({ sessionId, sessionToken }: { sessionId: string; sessionToken: string | null }) {
  const { formatTime, t } = useI18n();
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
      {logs.length === 0 && <p className="text-gray-600 p-2">{t("sessionView.logs.empty")}</p>}
      {logs.map((log) => (
        <pre key={log.id} className="mb-1 whitespace-pre-wrap break-all leading-relaxed">
          <span className="text-gray-600">{formatTime(log.timestamp)}</span>{" "}
          <span className={clsx(LOG_TYPE_COLOR[log.type] ?? "text-gray-400")}>[{log.type}]</span>{" "}
          <span className="text-gray-300">{formatLogMessage(log)}</span>
        </pre>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

export default function SessionViewPage() {
  const { locale, t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [activeTab, setActiveTab] = useState<SidebarTab>("details");
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
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
    sessionsApi.getToken(id).then((res) => setSessionToken(res.data.token)).catch(() => setTokenError(t("sessionView.tokenFailed")));
  }, [id, session?.status, t]);

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
        <p className="text-sm text-gray-400">{t("sessionView.notFound")}</p>
        <Link to="/sessions" className="text-sm text-gray-700 font-medium hover:text-gray-900 transition-colors">
          {t("sessionView.backToBrowsers")}
        </Link>
      </div>
    );
  }

  const browserSrc = sessionToken ? `/api/sessions/${id}/browser?token=${sessionToken}` : null;
  const tabs: { id: SidebarTab; label: string }[] = [
    { id: "details", label: t("sessionView.tabDetails") },
    { id: "logs", label: t("sessionView.tabLogs") },
    { id: "devtools", label: t("sessionView.tabDevtools") },
  ];

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <div className="w-6 h-6 bg-gray-700 rounded-lg flex items-center justify-center shrink-0">
          <Monitor size={13} className="text-gray-300" />
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-gray-100 truncate leading-tight">
            {session.name ?? t("common.unnamedBrowser")}
          </h1>
          <p className="text-xs text-gray-500 truncate font-mono">{session.id}</p>
        </div>

        {session.status === "running" && sessionToken ? (
          <button
            onClick={() => setConnectModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium transition-colors shrink-0"
          >
            <Plug size={12} />
            {t("sessionView.connectAgent")}
          </button>
        ) : (
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0",
              STATUS_STYLES[session.status]
            )}
          >
            <span className={clsx("w-1.5 h-1.5 rounded-full", STATUS_DOT[session.status])} />
            {getSessionStatusLabel(locale, session.status)}
          </span>
        )}
      </header>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 bg-gray-950 relative">
          {session.status === "creating" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center">
                <Loader2 size={22} className="animate-spin text-gray-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-300">{t("sessionView.startingTitle")}</p>
                <p className="text-xs text-gray-600 mt-1">{t("sessionView.startingHint")}</p>
              </div>
            </div>
          )}

          {session.status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-red-950 rounded-2xl flex items-center justify-center">
                <AlertCircle size={22} className="text-red-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-300">{t("sessionView.startFailed")}</p>
                <Link to="/sessions" className="text-xs text-gray-500 hover:text-gray-300 transition-colors mt-1 block">
                  {t("sessionView.backToBrowsers")}
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
                    sessionsApi.getToken(id!).then((res) => setSessionToken(res.data.token)).catch(() => setTokenError(t("sessionView.tokenFailed")));
                  }}
                  className="inline-flex items-center gap-1.5 mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <RefreshCw size={11} />
                  {t("common.retry")}
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
              key={iframeKey}
              ref={iframeRef}
              src={browserSrc}
              className="w-full h-full border-0"
              title={t("sessionView.iframeTitle")}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}

          {browserSrc && (
            <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
              <button
                onClick={() => setIframeKey((k) => k + 1)}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-900/70 hover:bg-gray-900 text-gray-400 hover:text-gray-100 backdrop-blur-sm transition-colors"
                title={t("sessionView.reloadBrowser")}
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={() => iframeRef.current?.requestFullscreen()}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-900/70 hover:bg-gray-900 text-gray-400 hover:text-gray-100 backdrop-blur-sm transition-colors"
                title={t("sessionView.fullscreen")}
              >
                <Maximize2 size={14} />
              </button>
            </div>
          )}
        </div>

        <aside className="w-96 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
          <div className="flex border-b border-gray-800 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  "flex-1 py-2.5 text-xs font-medium transition-colors",
                  activeTab === tab.id ? "text-gray-100 border-b-2 border-gray-100" : "text-gray-500 hover:text-gray-400"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "details" && <DetailsSidebar session={session} sessionToken={sessionToken} />}
          {activeTab === "logs" && <LogsSidebar sessionId={session.id} sessionToken={sessionToken} />}
          {activeTab === "devtools" && <DevToolsSidebar sessionId={session.id} sessionToken={sessionToken} />}
        </aside>
      </div>

      {connectModalOpen && sessionToken && (
        <ConnectAgentModal session={session} sessionToken={sessionToken} onClose={() => setConnectModalOpen(false)} />
      )}
    </div>
  );
}
