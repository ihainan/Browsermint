import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "zh";

interface MessageTree {
  [key: string]: string | MessageTree;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatDateTime: (value: string | number | Date) => string;
  formatTime: (value: string | number | Date) => string;
}

const STORAGE_KEY = "browsermint.locale";

const messages = {
  en: {
    common: {
      appName: "Browsermint",
      email: "Email",
      password: "Password",
      username: "Username",
      cancel: "Cancel",
      create: "Create",
      retry: "Retry",
      language: "Language",
      english: "English",
      chinese: "Chinese",
      signOut: "Sign out",
      unnamedBrowser: "Unnamed browser",
      statuses: {
        creating: "creating",
        running: "running",
        stopping: "stopping",
        stopped: "stopped",
        error: "error",
      },
    },
    login: {
      subtitle: "Cloud browser management",
      title: "Sign in to your account",
      submit: "Sign in",
      submitting: "Signing in…",
      noAccount: "No account?",
      createOne: "Create one",
      loginFailed: "Login failed",
    },
    register: {
      subtitle: "Cloud browser management",
      title: "Create your account",
      submit: "Create account",
      submitting: "Creating account…",
      hasAccount: "Already have an account?",
      signIn: "Sign in",
      passwordHint: "min. 8 characters",
      passwordTooShort: "Password must be at least 8 characters",
      registrationFailed: "Registration failed",
    },
    nav: {
      overview: "Overview",
      browsers: "Browsers",
      apiKey: "API Key",
    },
    sidebar: {
      usage: "Usage",
      usageBrowsers: "Browsers created",
    },
    overview: {
      title: "Overview",
      recentBrowsers: "Recent browsers",
      viewAll: "View all",
      analyticsTitle: "Analytics",
      totalBrowsers: "Total Browsers",
      runningBrowsers: "Running",
      stoppedBrowsers: "Stopped",
      errorBrowsers: "Error",
      noBrowsersYet: "No browsers yet",
      expiringSoon: "{count} browser(s) expiring within 30 days",
      expiringSoonLink: "View browsers",
      agentEvents: "Agent Events",
      dailyEvents: "Daily Events",
      dailyEventsSubtitle: "Last 7 days",
      hourlyActivity: "Activity by Hour",
      hourlyActivitySubtitle: "All time, local time",
      noEventsYet: "No events yet",
      eventsCount: "{count} events",
      capsolverTitle: "Captcha Solves",
      capsolverSuccess: "Succeeded",
      capsolverFailed: "Failed",
      capsolverAvgTime: "Avg. Time",
      capsolverNoData: "No captcha solves yet",
    },
    apiKey: {
      title: "API Key",
      comingSoon: "Coming soon",
      description: "API key management will be available here.",
    },
    browsers: {
      title: "Browsers",
      filterStatus: "Status",
      allStatuses: "All",
      browserId: "Browser ID",
      name: "Name",
      started: "Started",
      lastActive: "Last Active",
      expiresAt: "Expires",
      viewing: "Viewing {from}–{to} of {total} results",
      previous: "Previous",
      next: "Next",
    },
    user: {
      joinedAt: "Joined",
    },
    sessions: {
      title: "Cloud Browsers",
      count: "({current}/{max})",
      newBrowser: "New Browser",
      noBrowsers: "No browsers yet",
      noBrowsersHint: "Create one above to get started",
      created: "Created",
      lastActive: "Last active",
      container: "Container",
      disabled: "Disabled",
      moreOptions: "More options",
      disable: "Disable",
      resume: "Resume",
      delete: "Delete",
      browserNameRequired: "Browser name is required",
      browserNameDuplicate: "You already have a browser with this name",
      createBrowserFailed: "Failed to create browser",
      newBrowserModalTitle: "New Browser",
      browserNamePlaceholder: "Browser name",
      startingHint: "Starting cloud browser, this may take up to 30 seconds…",
      starting: "Starting…",
      deleteBrowserTitle: "Delete browser?",
      deleteBrowserHint: "This will permanently delete the browser and all its data. This action cannot be undone.",
    },
    sessionView: {
      notFound: "Browser not found",
      backToBrowsers: "← Back to browsers",
      connectAgent: "Connect Agent",
      startingTitle: "Starting cloud browser",
      startingHint: "This may take up to 30 seconds",
      startFailed: "Browser failed to start",
      tokenFailed: "Failed to get session access token",
      iframeTitle: "Cloud Browser",
      reloadBrowser: "Reload browser",
      fullscreen: "Fullscreen",
      tabDetails: "Details",
      tabLogs: "Logs",
      tabDevtools: "DevTools",
      details: {
        id: "ID",
        name: "Name",
        created: "Created",
        lastActive: "Last Active",
        container: "Container",
        duration: "Duration",
        userAgent: "User Agent",
        isSelenium: "isSelenium",
        autoCaptcha: "Auto-captcha",
        proxy: "Proxy",
        proxyTx: "Proxy TX",
        proxyRx: "Proxy RX",
        cost: "Cost",
        websocketUrl: "WebSocket URL",
        expiresAt: "Expires",
        cdpWebsocketUrl: "CDP WebSocket URL",
        tokenExpiresAt: "Token Expires",
        none: "None",
      },
      connect: {
        title: "Connect Agent",
        subtitle: "Connect this browser to your AI agent",
        cdpLabel: "CDP WebSocket URL",
        sessionIdLabel: "Session ID",
        openclawIntro: "Connect this browser to **OpenClaw** by adding a remote CDP profile in `~/.openclaw/openclaw.json`.",
        openclawConfig: "Add a browser profile to `~/.openclaw/openclaw.json`",
        openclawHint: "Restart the **OpenClaw Gateway** after saving. This token is **temporary** — fetch a fresh CDP URL before each agent run.",
        antigravityIntro: "Connect this browser to **Google Antigravity** via the **chrome-devtools MCP** server.",
        antigravityConfig: "Add to `~/.gemini/antigravity/mcp_config.json` (or via **Agent → MCP Servers → View raw config**)",
        antigravityHint: "After saving, go to **Agent (...) → MCP Servers → Manage MCP Servers** and click **Refresh**. This token is **temporary** — fetch a fresh CDP URL before each agent run.",
        claudeIntro: "Connect this browser to **Claude Code** via the **chrome-devtools MCP** server.",
        claudeConfigCli: "**Option 1** — add via CLI",
        claudeConfig: "**Option 2** — add to `.claude/settings.json`",
        claudeHint: "This token is **temporary** and expires when the session ends. Fetch a fresh CDP URL before each agent run.",
        codexIntro: "Connect this browser to **OpenAI Codex CLI** via the **chrome-devtools MCP** server.",
        codexConfigCli: "**Option 1** — add via CLI",
        codexConfig: "**Option 2** — add to `~/.codex/config.json`",
        codexHint: "This token is **temporary** and expires when the session ends. Fetch a fresh CDP URL before each agent run.",
        cursorIntro: "Connect this browser in **Cursor** via the **chrome-devtools MCP** server.",
        cursorConfig: "Add to **Cursor Settings → MCP** (or `.cursor/mcp.json`)",
        cursorHint: "Restart **Cursor's MCP server** after saving. Then ask the AI to control the browser.",
        customIntro: "Connect this browser session directly over CDP (Chrome DevTools Protocol).",
        playwrightNode: "Playwright (Node.js)",
        playwrightPython: "Playwright (Python)",
        customApi: "Custom / API",
        copy: "Copy",
        tokenExpiresAt: "Token expires at",
      },
      refreshToken: "Refresh Token",
      refreshTokenWarning: "Refreshing the token will invalidate the current one. Any agents currently connected to this browser will be disconnected.",
      refreshTokenConfirm: "Refresh Token",
      refreshTokenExpiringSoon: "This browser's token expires in {days} days.",
      refreshTokenExpired: "This browser's token has expired.",
      devtools: {
        intro: "DevTools opens in a separate window to avoid affecting the browser viewport.",
        open: "Open DevTools",
        ready: "DevTools will attach to the current page in a separate window.",
        waiting: "Waiting for the active page to become available...",
      },
      logs: {
        empty: "No logs yet…",
      },
    },
  },
  zh: {
    common: {
      appName: "Browsermint",
      email: "邮箱",
      password: "密码",
      username: "用户名",
      cancel: "取消",
      create: "创建",
      retry: "重试",
      language: "语言",
      english: "English",
      chinese: "中文",
      signOut: "退出登录",
      unnamedBrowser: "未命名浏览器",
      statuses: {
        creating: "创建中",
        running: "运行中",
        stopping: "停止中",
        stopped: "已停止",
        error: "错误",
      },
    },
    login: {
      subtitle: "云浏览器管理",
      title: "登录账户",
      submit: "登录",
      submitting: "登录中…",
      noAccount: "还没有账号？",
      createOne: "去注册",
      loginFailed: "登录失败",
    },
    register: {
      subtitle: "云浏览器管理",
      title: "创建账户",
      submit: "创建账户",
      submitting: "创建中…",
      hasAccount: "已有账号？",
      signIn: "去登录",
      passwordHint: "至少 8 个字符",
      passwordTooShort: "密码至少需要 8 个字符",
      registrationFailed: "注册失败",
    },
    nav: {
      overview: "概览",
      browsers: "浏览器",
      apiKey: "API Key",
    },
    sidebar: {
      usage: "用量",
      usageBrowsers: "已创建浏览器",
    },
    overview: {
      title: "概览",
      recentBrowsers: "最近浏览器",
      viewAll: "查看全部",
      analyticsTitle: "数据统计",
      totalBrowsers: "总浏览器数",
      runningBrowsers: "运行中",
      stoppedBrowsers: "已停止",
      errorBrowsers: "错误",
      noBrowsersYet: "还没有浏览器",
      expiringSoon: "{count} 个浏览器将在 30 天内过期",
      expiringSoonLink: "查看浏览器",
      agentEvents: "Agent 事件数",
      dailyEvents: "每日事件",
      dailyEventsSubtitle: "过去 7 天",
      hourlyActivity: "按小时分布",
      hourlyActivitySubtitle: "全时段，本地时间",
      noEventsYet: "暂无事件",
      eventsCount: "{count} 个事件",
      capsolverTitle: "验证码求解",
      capsolverSuccess: "成功",
      capsolverFailed: "失败",
      capsolverAvgTime: "平均耗时",
      capsolverNoData: "暂无验证码求解记录",
    },
    apiKey: {
      title: "API Key",
      comingSoon: "即将推出",
      description: "API Key 管理功能即将上线。",
    },
    browsers: {
      title: "浏览器",
      filterStatus: "状态",
      allStatuses: "全部",
      browserId: "浏览器 ID",
      name: "名称",
      started: "创建时间",
      lastActive: "最后活跃",
      expiresAt: "过期时间",
      viewing: "显示第 {from}–{to} 条，共 {total} 条",
      previous: "上一页",
      next: "下一页",
    },
    user: {
      joinedAt: "注册时间",
    },
    sessions: {
      title: "云浏览器",
      count: "({current}/{max})",
      newBrowser: "新建浏览器",
      noBrowsers: "还没有浏览器",
      noBrowsersHint: "在上方创建一个开始使用",
      created: "创建时间",
      lastActive: "最后活跃",
      container: "容器",
      disabled: "已禁用",
      moreOptions: "更多操作",
      disable: "禁用",
      resume: "恢复",
      delete: "删除",
      browserNameRequired: "浏览器名称不能为空",
      browserNameDuplicate: "你已经有同名浏览器了",
      createBrowserFailed: "创建浏览器失败",
      newBrowserModalTitle: "新建浏览器",
      browserNamePlaceholder: "浏览器名称",
      startingHint: "正在启动云浏览器，最多可能需要 30 秒…",
      starting: "启动中…",
      deleteBrowserTitle: "删除浏览器？",
      deleteBrowserHint: "这会永久删除该浏览器及其所有数据，此操作无法撤销。",
    },
    sessionView: {
      notFound: "未找到浏览器",
      backToBrowsers: "← 返回浏览器列表",
      connectAgent: "连接 Agent",
      startingTitle: "正在启动云浏览器",
      startingHint: "最多可能需要 30 秒",
      startFailed: "浏览器启动失败",
      tokenFailed: "获取会话访问令牌失败",
      iframeTitle: "云浏览器",
      reloadBrowser: "重新加载浏览器",
      fullscreen: "全屏",
      tabDetails: "详情",
      tabLogs: "日志",
      tabDevtools: "DevTools",
      details: {
        id: "ID",
        name: "名称",
        created: "创建时间",
        lastActive: "最后活跃",
        container: "容器",
        duration: "持续时间",
        userAgent: "User Agent",
        isSelenium: "isSelenium",
        autoCaptcha: "自动验证码",
        proxy: "代理",
        proxyTx: "代理发送",
        proxyRx: "代理接收",
        cost: "消耗",
        websocketUrl: "WebSocket 地址",
        expiresAt: "过期时间",
        cdpWebsocketUrl: "CDP WebSocket 地址",
        tokenExpiresAt: "Token 过期时间",
        none: "无",
      },
      connect: {
        title: "连接 Agent",
        subtitle: "将此浏览器接入你的 AI Agent",
        cdpLabel: "CDP WebSocket 地址",
        sessionIdLabel: "Session ID",
        openclawIntro: "在 `~/.openclaw/openclaw.json` 中添加远程 CDP 浏览器配置，将此浏览器接入 **OpenClaw**。",
        openclawConfig: "在 `~/.openclaw/openclaw.json` 中添加浏览器配置",
        openclawHint: "配置保存后需重启 **OpenClaw Gateway**。此 Token 为**临时凭证**，每次启动 Agent 前请重新获取 CDP 地址。",
        antigravityIntro: "通过 **chrome-devtools MCP** 服务器将此浏览器接入 **Google Antigravity**。",
        antigravityConfig: "添加到 `~/.gemini/antigravity/mcp_config.json`（或通过 **Agent → MCP Servers → View raw config**）",
        antigravityHint: "保存后进入 **Agent (...) → MCP Servers → Manage MCP Servers**，点击 **Refresh** 生效。此 Token 为**临时凭证**，每次启动 Agent 前请重新获取 CDP 地址。",
        claudeIntro: "通过 **chrome-devtools MCP** 服务器将此浏览器接入 **Claude Code**。",
        claudeConfigCli: "**方式一** — 通过 CLI 添加",
        claudeConfig: "**方式二** — 添加到 `.claude/settings.json`",
        claudeHint: "此 Token 为**临时凭证**，会话结束后失效。每次启动 Agent 前请重新获取 CDP 地址。",
        codexIntro: "通过 **chrome-devtools MCP** 服务器将此浏览器接入 **OpenAI Codex CLI**。",
        codexConfigCli: "**方式一** — 通过 CLI 添加",
        codexConfig: "**方式二** — 添加到 `~/.codex/config.json`",
        codexHint: "此 Token 为**临时凭证**，会话结束后失效。每次启动 Agent 前请重新获取 CDP 地址。",
        cursorIntro: "在 **Cursor** 中通过 **chrome-devtools MCP** 服务器连接此浏览器。",
        cursorConfig: "添加到 **Cursor 设置 → MCP**（或 `.cursor/mcp.json`）",
        cursorHint: "保存后重启 **Cursor MCP 服务**，然后在对话中要求 AI 操控浏览器。",
        customIntro: "通过 CDP（Chrome DevTools Protocol）直接接入此浏览器会话。",
        playwrightNode: "Playwright（Node.js）",
        playwrightPython: "Playwright（Python）",
        customApi: "自定义 / API",
        copy: "复制",
        tokenExpiresAt: "Token 过期时间",
      },
      refreshToken: "更新 Token",
      refreshTokenWarning: "更新 Token 后，当前 Token 将立即失效，正在使用此浏览器的 Agent 将会断开连接。",
      refreshTokenConfirm: "确认更新",
      refreshTokenExpiringSoon: "此浏览器的 Token 将在 {days} 天后过期。",
      refreshTokenExpired: "此浏览器的 Token 已过期。",
      devtools: {
        intro: "DevTools 会在独立窗口中打开，以避免影响浏览器视口。",
        open: "打开 DevTools",
        ready: "DevTools 会在独立窗口中附加到当前页面。",
        waiting: "等待当前活动页面可用…",
      },
      logs: {
        empty: "暂无日志…",
      },
    },
  },
} satisfies Record<Locale, MessageTree>;

const I18nContext = createContext<I18nContextValue | null>(null);

function detectSystemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

function getStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "en" || stored === "zh" ? stored : null;
}

function readMessage(locale: Locale, key: string): string {
  const result = key.split(".").reduce<string | MessageTree | undefined>((acc, part) => {
    if (acc && typeof acc === "object" && part in acc) {
      return acc[part];
    }
    return undefined;
  }, messages[locale]);

  return typeof result === "string" ? result : key;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getStoredLocale() ?? detectSystemLocale());

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale: (nextLocale) => {
      setLocaleState(nextLocale);
      window.localStorage.setItem(STORAGE_KEY, nextLocale);
    },
    t: (key, params) => interpolate(readMessage(locale, key), params),
    formatDateTime: (value) =>
      new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(value)),
    formatTime: (value) =>
      new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(value)),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
