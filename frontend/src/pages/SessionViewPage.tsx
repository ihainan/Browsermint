import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionsApi, Session, SteelSessionDetails } from "../api/client.ts";
import { Loader2, AlertCircle, Monitor, RefreshCw, Maximize2, X, Copy, Check, Plug, ExternalLink, ChevronRight, AlertTriangle, Lock, LockOpen } from "lucide-react";
import { daysUntilExpiry } from "./OverviewPage.tsx";
import clsx from "clsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { getSessionStatusLabel } from "../i18n/sessionStatus.ts";
import openclawIcon from "../assets/agents/openclaw.svg";
import claudeCodeIcon from "../assets/agents/claude-code.png";
import codexIcon from "../assets/agents/codex.png";
import cursorIcon from "../assets/agents/cursor.png";
import antigravityIcon from "../assets/agents/antigravity.png";
import hermesIcon from "../assets/agents/hermes.png";

const STATUS_STYLES: Record<Session["status"], string> = {
  creating: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  running: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  stopping: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  stopped: "bg-gray-100 text-gray-500 ring-1 ring-gray-200",
  error: "bg-red-50 text-red-600 ring-1 ring-red-200",
  paused: "bg-blue-50 text-blue-600 ring-1 ring-blue-200",
};

const STATUS_DOT: Record<Session["status"], string> = {
  creating: "bg-amber-400 animate-pulse",
  running: "bg-emerald-500",
  stopping: "bg-orange-400 animate-pulse",
  stopped: "bg-gray-400",
  error: "bg-red-500",
  paused: "bg-blue-400 animate-pulse",
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

function getCachedSessionToken(sessionId: string): string | null {
  try {
    const stored = localStorage.getItem(`session-token-${sessionId}`);
    if (!stored) return null;
    const parts = stored.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      localStorage.removeItem(`session-token-${sessionId}`);
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

function setCachedSessionToken(sessionId: string, token: string) {
  localStorage.setItem(`session-token-${sessionId}`, token);
}

function normalizeWsUrl(url: string): string {
  if (window.location.protocol === "https:" && url.startsWith("ws://")) {
    return "wss://" + url.slice(5);
  }
  return url;
}

function InlineCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="absolute top-1.5 right-1.5 p-1 rounded bg-white/90 hover:bg-white text-gray-400 hover:text-gray-700 border border-slate-200 transition-colors opacity-0 group-hover:opacity-100"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function DetailRow({ label, value, mono = false, copyable = false }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-gray-100">
      <span className="text-xs text-gray-500">{label}</span>
      {copyable ? (
        <div className="relative group mt-0.5">
          <pre className="bg-slate-50 text-gray-700 text-xs rounded-md p-2 pr-8 whitespace-pre-wrap break-all leading-relaxed border border-slate-200 font-mono">{value}</pre>
          <button
            onClick={copy}
            className="absolute top-1.5 right-1.5 p-1 rounded bg-white/90 hover:bg-white text-gray-400 hover:text-gray-700 border border-slate-200 transition-colors opacity-0 group-hover:opacity-100"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
      ) : (
        <span className={clsx("text-xs text-gray-700 break-all", mono && "font-mono")}>{value}</span>
      )}
    </div>
  );
}

function DetailsSidebar({
  session,
  sessionToken,
  onTokenRefreshed,
}: {
  session: Session;
  sessionToken: string | null;
  onTokenRefreshed: (newToken: string) => void;
}) {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const [details, setDetails] = useState<SteelSessionDetails | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!sessionToken) return;
    sessionsApi.getDetails(session.id, sessionToken).then((r) => setDetails(r.data)).catch(() => {});
    const interval = setInterval(() => {
      sessionsApi.getDetails(session.id, sessionToken).then((r) => setDetails(r.data)).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [session.id, sessionToken]);

  const refreshMutation = useMutation({
    mutationFn: () => sessionsApi.refreshToken(session.id),
    onSuccess: (res) => {
      onTokenRefreshed(res.data.token);
      queryClient.setQueryData(["session", session.id], res.data.session);
      setConfirmOpen(false);
    },
  });

  const cdpUrl = sessionToken
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/sessions/${session.id}/cdp?token=${sessionToken}`
    : null;

  const days = daysUntilExpiry(session.expiresAt);
  const isExpired = days !== null && days <= 0;
  const isExpiringSoon = days !== null && days > 0 && days <= 30;

  return (
    <div className="overflow-y-auto flex-1 px-3 pb-4 font-mono text-xs">
      <DetailRow label={t("sessionView.details.id")} value={session.id} mono />
      <DetailRow label={t("sessionView.details.name")} value={session.name ?? "—"} />

      {/* CDP WebSocket URL — only shown once the full devtools URL is available */}
      {cdpUrl && details?.websocketUrl && (
        <div className="flex flex-col gap-0.5 py-2.5 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">{t("sessionView.details.cdpWebsocketUrl")}</span>
            <button
              onClick={() => setConfirmOpen(true)}
              className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-700 transition-colors"
              title={t("sessionView.refreshToken")}
            >
              <RefreshCw size={11} />
              {t("sessionView.refreshToken")}
            </button>
          </div>
          <div className="relative group mt-0.5">
            <pre className="bg-slate-50 text-gray-700 text-xs rounded-md p-2 pr-8 whitespace-pre-wrap break-all leading-relaxed border border-slate-200 font-mono">{normalizeWsUrl(details.websocketUrl)}</pre>
            <InlineCopyButton value={normalizeWsUrl(details.websocketUrl)} />
          </div>
        </div>
      )}

      {/* Expiry info */}
      {session.expiresAt && (
        <div className="flex flex-col gap-0.5 py-2.5 border-b border-gray-100">
          <span className="text-xs text-gray-500">{t("sessionView.details.expiresAt")}</span>
          <span className={clsx(
            "text-xs break-all",
            isExpired ? "text-red-500 font-medium" : isExpiringSoon ? "text-amber-600" : "text-gray-700"
          )}>
            {formatDateTime(session.expiresAt)}
          </span>
        </div>
      )}

      {/* Expiry warning banner */}
      {(isExpired || isExpiringSoon) && (
        <div className={clsx(
          "flex flex-col gap-2 rounded-md px-3 py-2.5 my-2 border",
          isExpired ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"
        )}>
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={12} className={clsx("mt-0.5 shrink-0", isExpired ? "text-red-500" : "text-amber-500")} />
            <span className={clsx("text-xs leading-relaxed", isExpired ? "text-red-700" : "text-amber-700")}>
              {isExpired
                ? t("sessionView.refreshTokenExpired")
                : t("sessionView.refreshTokenExpiringSoon", { days: String(days) })}
            </span>
          </div>
          {session.status === "running" && (
            <button
              onClick={() => setConfirmOpen(true)}
              className={clsx(
                "self-start text-xs font-medium px-2.5 py-1 rounded-md transition-colors",
                isExpired
                  ? "bg-red-100 hover:bg-red-200 text-red-700"
                  : "bg-amber-100 hover:bg-amber-200 text-amber-700"
              )}
            >
              {t("sessionView.refreshToken")}
            </button>
          )}
        </div>
      )}
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
      {details?.tokenExpiresAt && <DetailRow label={t("sessionView.details.tokenExpiresAt")} value={formatDateTime(details.tokenExpiresAt)} />}

      {/* Refresh token confirmation dialog */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div
            className="bg-white rounded-lg shadow-2xl border border-gray-200 p-6 w-80 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                <AlertTriangle size={15} className="text-amber-600" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-1">{t("sessionView.refreshToken")}</h3>
                <p className="text-xs text-gray-500 leading-relaxed">{t("sessionView.refreshTokenWarning")}</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={refreshMutation.isPending}
                className="px-3.5 py-2 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                className="px-3.5 py-2 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {refreshMutation.isPending && <Loader2 size={11} className="animate-spin" />}
                {t("sessionView.refreshTokenConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type AgentPlatform = "openclaw" | "claude-code" | "codex" | "cursor" | "antigravity" | "hermes";

function usePlatforms() {
  return [
    { id: "openclaw" as const, label: "OpenClaw", icon: openclawIcon },
    { id: "hermes" as const, label: "Hermes", icon: hermesIcon },
    { id: "claude-code" as const, label: "Claude Code", icon: claudeCodeIcon },
    { id: "codex" as const, label: "Codex", icon: codexIcon },
    { id: "cursor" as const, label: "Cursor", icon: cursorIcon },
    { id: "antigravity" as const, label: "Antigravity", icon: antigravityIcon },
  ];
}

// ── RichText ────────────────────────────────────────────────────────────────

type RichSegment = { type: "bold" | "code" | "link" | "text"; value: string; href?: string };

function parseRichText(text: string): RichSegment[] {
  const segments: RichSegment[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: "text", value: text.slice(last, match.index) });
    const raw = match[0];
    if (raw.startsWith("**")) {
      segments.push({ type: "bold", value: raw.slice(2, -2) });
    } else if (raw.startsWith("`")) {
      segments.push({ type: "code", value: raw.slice(1, -1) });
    } else {
      const label = raw.match(/\[([^\]]+)\]/)![1];
      const href = raw.match(/\(([^)]+)\)/)![1];
      segments.push({ type: "link", value: label, href });
    }
    last = match.index + raw.length;
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) });
  return segments;
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {parseRichText(text).map((seg, i) => {
        if (seg.type === "bold") return <strong key={i} className="font-semibold text-[#0d7a5f]">{seg.value}</strong>;
        if (seg.type === "code") return <code key={i} className="font-mono bg-slate-100 text-slate-700 px-1 rounded text-[0.82em]">{seg.value}</code>;
        if (seg.type === "link") return <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="underline text-[#0d7a5f] hover:opacity-70">{seg.value}</a>;
        return <span key={i}>{seg.value}</span>;
      })}
    </>
  );
}

// ── Syntax highlighting ──────────────────────────────────────────────────────

type Token = { type: "key" | "string" | "number" | "boolean" | "null" | "punct" | "plain"; value: string };

function tokenizeJson(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    // whitespace / newlines
    if (/\s/.test(code[i])) {
      tokens.push({ type: "plain", value: code[i++] });
      continue;
    }
    // string — check if it's a key (followed by colon after closing quote)
    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && !(code[j] === '"' && code[j - 1] !== "\\")) j++;
      const raw = code.slice(i, j + 1);
      i = j + 1;
      // skip whitespace to peek at next non-space char
      let k = i;
      while (k < code.length && code[k] === " ") k++;
      const isKey = code[k] === ":";
      tokens.push({ type: isKey ? "key" : "string", value: raw });
      continue;
    }
    // number
    if (/[-\d]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[-\d.eE+]/.test(code[j])) j++;
      tokens.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // boolean / null keywords
    const kw = ["true", "false", "null"].find((k) => code.startsWith(k, i));
    if (kw) {
      tokens.push({ type: kw === "null" ? "null" : "boolean", value: kw });
      i += kw.length;
      continue;
    }
    // punctuation
    if (/[{}\[\]:,]/.test(code[i])) {
      tokens.push({ type: "punct", value: code[i++] });
      continue;
    }
    tokens.push({ type: "plain", value: code[i++] });
  }
  return tokens;
}

const TOKEN_COLORS: Record<Token["type"], string> = {
  key: "text-blue-700",
  string: "text-emerald-700",
  number: "text-amber-600",
  boolean: "text-purple-600",
  null: "text-gray-400",
  punct: "text-gray-500",
  plain: "text-gray-800",
};

function tokenizeShell(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (/\s/.test(code[i])) { tokens.push({ type: "plain", value: code[i++] }); continue; }
    // quoted string
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i]; let j = i + 1;
      while (j < code.length && code[j] !== q) j++;
      tokens.push({ type: "string", value: code.slice(i, j + 1) });
      i = j + 1; continue;
    }
    // --flag (possibly --flag=)
    if (code[i] === "-" && code[i + 1] === "-") {
      let j = i;
      while (j < code.length && !/[\s"']/.test(code[j]) && code[j] !== "=") j++;
      if (code[j] === "=") {
        tokens.push({ type: "number", value: code.slice(i, j + 1) });
        i = j + 1;
      } else {
        tokens.push({ type: "number", value: code.slice(i, j) });
        i = j;
      }
      continue;
    }
    // plain token
    let j = i;
    while (j < code.length && !/\s/.test(code[j])) j++;
    tokens.push({ type: "plain", value: code.slice(i, j) });
    i = j;
  }
  return tokens;
}

function HighlightedCode({ code }: { code: string }) {
  const trimmed = code.trimStart();
  const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const tokenize = isJson ? tokenizeJson : tokenizeShell;
  return (
    <>
      {tokenize(code).map((tok, idx) => (
        <span key={idx} className={TOKEN_COLORS[tok.type]}>{tok.value}</span>
      ))}
    </>
  );
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
      <pre className="bg-slate-50 text-gray-800 text-xs rounded-lg p-3 whitespace-pre-wrap break-all leading-relaxed border border-slate-200">
        <HighlightedCode code={code} />
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 p-1.5 rounded bg-white/90 hover:bg-white text-gray-500 hover:text-gray-900 border border-slate-200 transition-colors opacity-0 group-hover:opacity-100"
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
  tokenExpiresAt,
}: {
  platform: AgentPlatform;
  cdpUrl: string;
  sessionId: string;
  tokenExpiresAt?: string;
}) {
  const { t } = useI18n();

  const expiryLine = tokenExpiresAt ? (
    <p className="text-xs font-medium text-amber-600">
      {t("sessionView.connect.tokenExpiresAt")}: {tokenExpiresAt}
    </p>
  ) : null;

  if (platform === "openclaw") {
    const openclawMcpCli = `openclaw mcp set cloud-browser '{"command":"npx","args":["chrome-devtools-mcp@latest","--wsEndpoint=${cdpUrl}"]}'`;
    const openclawMcpJson = `{\n  "mcp": {\n    "servers": {\n      "cloud-browser": {\n        "command": "npx",\n        "args": [\n          "chrome-devtools-mcp@latest",\n          "--wsEndpoint=${cdpUrl}"\n        ]\n      }\n    }\n  }\n}`;
    return (
      <div className="space-y-4 text-sm text-gray-700">
        <p><RichText text={t("sessionView.connect.openclawIntro")} /></p>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.openclawConfigCli")} /></p>
          <CodeBlock code={openclawMcpCli} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.openclawConfig")} /></p>
          <CodeBlock code={openclawMcpJson} />
        </div>
        <p className="text-xs text-gray-500"><RichText text={t("sessionView.connect.openclawHint")} /></p>
        {expiryLine}
      </div>
    );
  }

  if (platform === "claude-code") {
    const mcpJson = `{\n  "mcpServers": {\n    "cloud-browser": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "chrome-devtools-mcp@latest",\n        "--wsEndpoint=${cdpUrl}"\n      ]\n    }\n  }\n}`;
    const mcpCli = `claude mcp add cloud-browser --scope user -- npx chrome-devtools-mcp@latest --wsEndpoint="${cdpUrl}"`;
    return (
      <div className="space-y-4 text-sm text-gray-700">
        <p><RichText text={t("sessionView.connect.claudeIntro")} /></p>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.claudeConfigCli")} /></p>
          <CodeBlock code={mcpCli} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.claudeConfig")} /></p>
          <CodeBlock code={mcpJson} />
        </div>
        <p className="text-xs text-gray-500"><RichText text={t("sessionView.connect.claudeHint")} /></p>
        {expiryLine}
      </div>
    );
  }

  if (platform === "cursor") {
    const mcpJson = `{\n  "mcpServers": {\n    "cloud-browser": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "chrome-devtools-mcp@latest",\n        "--wsEndpoint=${cdpUrl}"\n      ]\n    }\n  }\n}`;
    return (
      <div className="space-y-4 text-sm text-gray-700">
        <p><RichText text={t("sessionView.connect.cursorIntro")} /></p>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.cursorConfig")} /></p>
          <CodeBlock code={mcpJson} />
        </div>
        <p className="text-xs text-gray-500"><RichText text={t("sessionView.connect.cursorHint")} /></p>
        {expiryLine}
      </div>
    );
  }

  if (platform === "codex") {
    const mcpJson = `{\n  "mcpServers": {\n    "cloud-browser": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "chrome-devtools-mcp@latest",\n        "--wsEndpoint=${cdpUrl}"\n      ]\n    }\n  }\n}`;
    const mcpCli = `codex mcp add cloud-browser -- npx chrome-devtools-mcp@latest --wsEndpoint="${cdpUrl}"`;
    return (
      <div className="space-y-4 text-sm text-gray-700">
        <p><RichText text={t("sessionView.connect.codexIntro")} /></p>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.codexConfigCli")} /></p>
          <CodeBlock code={mcpCli} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.codexConfig")} /></p>
          <CodeBlock code={mcpJson} />
        </div>
        <p className="text-xs text-gray-500"><RichText text={t("sessionView.connect.codexHint")} /></p>
        {expiryLine}
      </div>
    );
  }

  if (platform === "antigravity") {
    const mcpJson = `{\n  "mcpServers": {\n    "cloud-browser": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "chrome-devtools-mcp@latest",\n        "--wsEndpoint=${cdpUrl}"\n      ]\n    }\n  }\n}`;
    return (
      <div className="space-y-4 text-sm text-gray-700">
        <p><RichText text={t("sessionView.connect.antigravityIntro")} /></p>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.antigravityConfig")} /></p>
          <CodeBlock code={mcpJson} />
        </div>
        <p className="text-xs text-gray-500"><RichText text={t("sessionView.connect.antigravityHint")} /></p>
        {expiryLine}
      </div>
    );
  }

  if (platform === "hermes") {
    const hermesYaml = `mcp_servers:\n  cloud-browser:\n    command: "npx"\n    args: ["-y", "chrome-devtools-mcp@latest", "--wsEndpoint=${cdpUrl}"]`;
    return (
      <div className="space-y-4 text-sm text-gray-700">
        <p><RichText text={t("sessionView.connect.hermesIntro")} /></p>
        <div>
          <p className="text-xs text-gray-500 mb-1"><RichText text={t("sessionView.connect.hermesConfig")} /></p>
          <CodeBlock code={hermesYaml} />
        </div>
        <p className="text-xs text-gray-500"><RichText text={t("sessionView.connect.hermesHint")} /></p>
        {expiryLine}
      </div>
    );
  }

  return (
    <div className="h-full" />
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
  const { t, formatDateTime } = useI18n();
  const platforms = usePlatforms();
  const [platform, setPlatform] = useState<AgentPlatform>("openclaw");
  const [cdpUrl, setCdpUrl] = useState(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/sessions/${session.id}/cdp?token=${sessionToken}`
  );
  const [tokenExpiresAt, setTokenExpiresAt] = useState<string | undefined>();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    sessionsApi.getDetails(session.id, sessionToken).then((res) => {
      if (cancelled) return;
      // Do NOT overwrite cdpUrl with the full devtools URL (which contains a volatile
      // Chrome instance UUID that changes on every Chrome restart). The base cdpUrl
      // is stable — the backend now auto-resolves the current UUID transparently.
      if (typeof res.data.tokenExpiresAt === "string") {
        setTokenExpiresAt(formatDateTime(res.data.tokenExpiresAt));
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [session.id, sessionToken, formatDateTime]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/18 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-slate-300 rounded-2xl shadow-[0_24px_70px_-24px_rgba(15,23,42,0.4)] ring-1 ring-slate-200/80 w-full max-w-5xl mx-4 flex flex-col min-h-[72vh] max-h-[88vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">{t("sessionView.connect.title")}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t("sessionView.connect.subtitle")}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-slate-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-40 border-r border-slate-100 py-3 shrink-0 bg-slate-50/70 rounded-l-2xl">
            {platforms.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlatform(p.id)}
                className={clsx(
                  "w-full flex items-center gap-3 text-left px-4 py-3 text-xs font-medium transition-colors",
                  platform === p.id ? "text-gray-900 bg-white" : "text-gray-500 hover:text-gray-900 hover:bg-white/70"
                )}
              >
                <img src={p.icon} alt={p.label} className="w-5 h-5 shrink-0 object-contain" />
                <span>{p.label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            <PlatformContent platform={platform} cdpUrl={cdpUrl} sessionId={session.id} tokenExpiresAt={tokenExpiresAt} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DevToolsSidebar({ sessionId, sessionToken, onPageIdChange }: { sessionId: string; sessionToken: string | null; onPageIdChange?: (pageId: string) => void }) {
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
        if (res.data.pageId) onPageIdChange?.(res.data.pageId);
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
          onPageIdChange?.(payload.pageId);
          sessionsApi.getDevtoolsTarget(sessionId, sessionToken).then((res) => {
            setPageId(res.data.pageId);
            if (res.data.pageId) onPageIdChange?.(res.data.pageId);
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
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1dc99a] hover:bg-[#17a87f] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors shadow-sm"
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
          <span className="text-gray-700">{formatLogMessage(log)}</span>
        </pre>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function BrowserContextMenu({
  x, y, onClose, onCopy, onPaste,
}: {
  x: number; y: number;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position so the menu doesn't overflow the viewport
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    if (!menuRef.current) return;
    const { offsetWidth: w, offsetHeight: h } = menuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: x + w > vw ? Math.max(0, vw - w - 4) : x,
      y: y + h > vh ? Math.max(0, vh - h - 4) : y,
    });
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const item = "flex items-center gap-2 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-100 rounded cursor-pointer select-none";

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className={item} onMouseDown={(e) => { e.preventDefault(); onCopy(); onClose(); }}>
        <Copy size={13} className="text-gray-400" />
        Copy
      </div>
      <div className={item} onMouseDown={(e) => { e.preventDefault(); onPaste(); onClose(); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
        Paste
      </div>
    </div>
  );
}

export default function SessionViewPage() {
  const { locale, t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [activeTab, setActiveTab] = useState<SidebarTab>("details");
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [viewOnly, setViewOnly] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const browserContainerRef = useRef<HTMLDivElement>(null);

  // Clipboard bridge: relay host clipboard ↔ browser iframe via postMessage.
  const handleClipboardMessage = useCallback(async (event: MessageEvent) => {
    if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
    switch (event.data?.type) {
      case "showContextMenu": {
        const rect = iframeRef.current.getBoundingClientRect();
        setContextMenu({ x: rect.left + event.data.clientX, y: rect.top + event.data.clientY });
        break;
      }
      case "requestClipboardRead": {
        let response: Record<string, unknown>;
        try {
          const text = await navigator.clipboard.readText();
          response = { type: "clipboardReadResponse", text, requestId: event.data.requestId };
        } catch {
          response = { type: "clipboardReadResponse", error: "Failed to read clipboard", requestId: event.data.requestId };
        }
        iframeRef.current.contentWindow?.postMessage(response, "*");
        break;
      }
      case "requestClipboardWrite": {
        let response: Record<string, unknown>;
        try {
          await navigator.clipboard.writeText(event.data.text);
          response = { type: "clipboardWriteResponse", success: true, requestId: event.data.requestId };
        } catch {
          response = { type: "clipboardWriteResponse", success: false, error: "Failed to write clipboard", requestId: event.data.requestId };
        }
        iframeRef.current.contentWindow?.postMessage(response, "*");
        break;
      }
    }
  }, []);

  const toggleViewOnly = useCallback(() => {
    setViewOnly((prev) => {
      const next = !prev;
      iframeRef.current?.contentWindow?.postMessage({ type: "setViewOnly", value: next }, "*");
      return next;
    });
  }, []);

  const handleContextMenuCopy = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "triggerCopy" }, "*");
  }, []);

  const handleContextMenuPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) iframeRef.current?.contentWindow?.postMessage({ type: "triggerPaste", text }, "*");
    } catch { /* clipboard permission denied */ }
  }, []);

  // Ctrl+V pressed while the browser container (not the iframe itself) is focused.
  const handleBrowserContainerKeyDown = useCallback(async (event: KeyboardEvent) => {
    if (!browserContainerRef.current?.contains(document.activeElement)) return;
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;
    if (isCtrlOrCmd && (event.key === "v" || event.key === "V")) {
      event.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) iframeRef.current?.contentWindow?.postMessage({ type: "triggerPaste", text }, "*");
      } catch { /* clipboard permission denied */ }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleClipboardMessage);
    document.addEventListener("keydown", handleBrowserContainerKeyDown, true);
    return () => {
      window.removeEventListener("message", handleClipboardMessage);
      document.removeEventListener("keydown", handleBrowserContainerKeyDown, true);
    };
  }, [handleClipboardMessage, handleBrowserContainerKeyDown]);

  const { data: sessionData, isPending } = useQuery({
    queryKey: ["session", id],
    queryFn: () => sessionsApi.get(id!).then((r) => r.data.session),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "creating" || status === "stopping" || status === "paused" ? 2000 : 10000;
    },
    enabled: !!id,
  });

  const session = sessionData;

  useEffect(() => {
    if (!id || (session?.status !== "running" && session?.status !== "paused")) {
      // Clear the token so polling in sidebars stops immediately; otherwise
      // the still-running intervals would hit proxy endpoints that return 401
      // for non-running sessions, triggering a global auth logout.
      setSessionToken(null);
      return;
    }
    setTokenError("");
    const cached = getCachedSessionToken(id);
    if (cached) {
      setSessionToken(cached);
      return;
    }
    sessionsApi.getToken(id).then((res) => {
      setSessionToken(res.data.token);
      setCachedSessionToken(id, res.data.token);
    }).catch(() => setTokenError(t("sessionView.tokenFailed")));
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

  const browserSrc = sessionToken ? `/api/sessions/${id}/vnc-viewer?token=${sessionToken}` : null;
  const tabs: { id: SidebarTab; label: string }[] = [
    { id: "details", label: t("sessionView.tabDetails") },
    { id: "logs", label: t("sessionView.tabLogs") },
    { id: "devtools", label: t("sessionView.tabDevtools") },
  ];

  return (
    <div className="flex flex-col h-screen bg-slate-100">
      <header className="bg-white/95 backdrop-blur border-b border-slate-200 px-4 py-3 flex items-center gap-3 shrink-0 shadow-sm">
        <div className="w-7 h-7 bg-[#1dc99a] rounded-lg flex items-center justify-center shrink-0 shadow-sm">
          <Monitor size={13} className="text-white" />
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-gray-900 truncate leading-tight">
            {session.name ?? t("common.unnamedBrowser")}
          </h1>
          <p className="text-xs text-gray-400 truncate font-mono">{session.id}</p>
        </div>

        {session.status === "running" && sessionToken ? (
          <button
            onClick={() => setConnectModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1dc99a] hover:bg-[#17a87f] text-white text-xs font-medium transition-colors shrink-0 shadow-sm"
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
        <div ref={browserContainerRef} className="flex-1 flex flex-col bg-white relative shadow-inner" tabIndex={-1} style={{ outline: "none" }}>
          {browserSrc && (
            <div
              className={clsx(
                "flex items-center justify-between px-3 py-2 shrink-0 text-xs font-semibold transition-colors",
                viewOnly
                  ? "bg-amber-500 text-white"
                  : "bg-emerald-600 text-white"
              )}
            >
              <span className="flex items-center gap-1.5">
                {viewOnly ? <Lock size={12} /> : <LockOpen size={12} />}
                {viewOnly ? t("sessionView.viewOnlyMode") : t("sessionView.interactiveMode")}
              </span>
              <button
                onClick={toggleViewOnly}
                className="px-2.5 py-0.5 rounded-full bg-white/20 hover:bg-white/35 text-white text-xs font-semibold transition-colors shrink-0"
              >
                {viewOnly ? t("sessionView.enableInteraction") : t("sessionView.disableInteraction")}
              </button>
            </div>
          )}
          <div className="flex-1 relative">
          {session.status === "creating" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center border border-slate-200">
                <Loader2 size={22} className="animate-spin text-gray-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-900">{t("sessionView.startingTitle")}</p>
                <p className="text-xs text-gray-500 mt-1">{t("sessionView.startingHint")}</p>
              </div>
            </div>
          )}

          {session.status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-red-50 rounded-2xl flex items-center justify-center border border-red-100">
                <AlertCircle size={22} className="text-red-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-900">{t("sessionView.startFailed")}</p>
                <Link to="/sessions" className="text-xs text-gray-500 hover:text-gray-900 transition-colors mt-1 block">
                  {t("sessionView.backToBrowsers")}
                </Link>
              </div>
            </div>
          )}

          {session.status === "running" && tokenError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 bg-amber-50 rounded-2xl flex items-center justify-center border border-amber-100">
                <AlertCircle size={22} className="text-amber-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-900">{tokenError}</p>
                <button
                  onClick={() => {
                    setTokenError("");
                    sessionsApi.getToken(id!).then((res) => {
                      setSessionToken(res.data.token);
                      setCachedSessionToken(id!, res.data.token);
                    }).catch(() => setTokenError(t("sessionView.tokenFailed")));
                  }}
                  className="inline-flex items-center gap-1.5 mt-2 text-xs text-gray-500 hover:text-gray-900 transition-colors"
                >
                  <RefreshCw size={11} />
                  {t("common.retry")}
                </button>
              </div>
            </div>
          )}

          {session.status === "running" && !tokenError && !sessionToken && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={22} className="animate-spin text-gray-400" />
            </div>
          )}

          {browserSrc && (
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={browserSrc}
              className="w-full h-full border-0"
              title={t("sessionView.iframeTitle")}
              sandbox="allow-scripts allow-same-origin"
            />
          )}

          {browserSrc && (
            <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
              <button
                onClick={() => { setIframeKey((k) => k + 1); setViewOnly(true); }}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/90 hover:bg-white text-gray-500 hover:text-gray-900 border border-slate-200 backdrop-blur-sm transition-colors shadow-sm"
                title={t("sessionView.reloadBrowser")}
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={() => iframeRef.current?.requestFullscreen()}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/90 hover:bg-white text-gray-500 hover:text-gray-900 border border-slate-200 backdrop-blur-sm transition-colors shadow-sm"
                title={t("sessionView.fullscreen")}
              >
                <Maximize2 size={14} />
              </button>
            </div>
          )}
          </div>
        </div>

        {contextMenu && (
          <BrowserContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onCopy={handleContextMenuCopy}
            onPaste={handleContextMenuPaste}
          />
        )}

        <aside className="w-96 bg-white border-l border-slate-200 flex flex-col shrink-0 shadow-[-10px_0_30px_-24px_rgba(15,23,42,0.25)]">
          <div className="flex border-b border-slate-100 shrink-0 bg-slate-50/80">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  "flex-1 py-2.5 text-xs font-medium transition-colors",
                  activeTab === tab.id ? "text-gray-900 border-b-2 border-gray-900 bg-white" : "text-gray-500 hover:text-gray-900"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "details" && (
            <DetailsSidebar
              session={session}
              sessionToken={sessionToken}
              onTokenRefreshed={(newToken) => { setSessionToken(newToken); setCachedSessionToken(session.id, newToken); }}
            />
          )}
          {activeTab === "logs" && <LogsSidebar sessionId={session.id} sessionToken={sessionToken} />}
          {activeTab === "devtools" && <DevToolsSidebar sessionId={session.id} sessionToken={sessionToken} onPageIdChange={setActivePageId} />}
        </aside>
      </div>

      {connectModalOpen && sessionToken && (
        <ConnectAgentModal session={session} sessionToken={sessionToken} onClose={() => setConnectModalOpen(false)} />
      )}
    </div>
  );
}
