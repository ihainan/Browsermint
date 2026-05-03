export interface LogEntry {
  id: string;
  timestamp: string;
  type: "Console" | "Request" | "Response" | "Error" | "Navigation";
  text: string;
  payload?: Record<string, unknown>;
}

export interface RawLogEvent {
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

export function formatLogMessage(log: LogEntry): string {
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

export function normalizeIncomingLogs(data: string): LogEntry[] {
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

export function getCachedSessionToken(sessionId: string): string | null {
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

export function setCachedSessionToken(sessionId: string, token: string) {
  localStorage.setItem(`session-token-${sessionId}`, token);
}

export function normalizeWsUrl(url: string): string {
  if (window.location.protocol === "https:" && url.startsWith("ws://")) {
    return "wss://" + url.slice(5);
  }
  return url;
}

export type RichSegment = { type: "bold" | "code" | "link" | "text"; value: string; href?: string };

export function parseRichText(text: string): RichSegment[] {
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

export type Token = { type: "key" | "string" | "number" | "boolean" | "null" | "punct" | "plain"; value: string };

export function tokenizeJson(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (/\s/.test(code[i])) {
      tokens.push({ type: "plain", value: code[i++] });
      continue;
    }
    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && !(code[j] === '"' && code[j - 1] !== "\\")) j++;
      const raw = code.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (k < code.length && code[k] === " ") k++;
      const isKey = code[k] === ":";
      tokens.push({ type: isKey ? "key" : "string", value: raw });
      continue;
    }
    if (/[-\d]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[-\d.eE+]/.test(code[j])) j++;
      tokens.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }
    const kw = ["true", "false", "null"].find((k) => code.startsWith(k, i));
    if (kw) {
      tokens.push({ type: kw === "null" ? "null" : "boolean", value: kw });
      i += kw.length;
      continue;
    }
    if (/[{}\[\]:,]/.test(code[i])) {
      tokens.push({ type: "punct", value: code[i++] });
      continue;
    }
    tokens.push({ type: "plain", value: code[i++] });
  }
  return tokens;
}

export function tokenizeShell(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (/\s/.test(code[i])) { tokens.push({ type: "plain", value: code[i++] }); continue; }
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i]; let j = i + 1;
      while (j < code.length && code[j] !== q) j++;
      tokens.push({ type: "string", value: code.slice(i, j + 1) });
      i = j + 1; continue;
    }
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
    let j = i;
    while (j < code.length && !/\s/.test(code[j])) j++;
    tokens.push({ type: "plain", value: code.slice(i, j) });
    i = j;
  }
  return tokens;
}
