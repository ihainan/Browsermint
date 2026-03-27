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

const STORAGE_KEY = "steelyard.locale";

const messages = {
  en: {
    common: {
      appName: "SteelYard",
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
        none: "None",
      },
      connect: {
        title: "Connect Agent",
        subtitle: "Connect this browser to your AI agent",
        cdpLabel: "CDP WebSocket URL",
        sessionIdLabel: "Session ID",
        openclawIntro: "In OpenClaw, configure this browser session as a remote CDP browser.",
        openclawConfig: "Set this in your OpenClaw config",
        openclawHint: "The session stays valid while the browser window remains active. The token changes when the session refreshes, so fetch the latest CDP URL before starting your agent.",
        claudeIntro: "Connect this browser to Claude Code through MCP so Claude can control it directly.",
        claudeConfig: "Add this MCP server to .claude/settings.json",
        claudeHint: "You need @playwright/mcp installed. This token is temporary and must be fetched again after each session restart.",
        cursorIntro: "Connect this browser in Cursor through MCP so the AI can control it.",
        cursorConfig: "Add this in Cursor Settings → MCP",
        cursorHint: "Restart Cursor after saving. Then you can ask the AI to control the browser.",
        customIntro: "Connect this browser session directly over CDP (Chrome DevTools Protocol).",
        playwrightNode: "Playwright (Node.js)",
        playwrightPython: "Playwright (Python)",
        customApi: "Custom / API",
        copy: "Copy",
      },
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
      appName: "SteelYard",
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
        none: "无",
      },
      connect: {
        title: "连接 Agent",
        subtitle: "将此浏览器接入你的 AI Agent",
        cdpLabel: "CDP WebSocket 地址",
        sessionIdLabel: "Session ID",
        openclawIntro: "在 OpenClaw 中，将此浏览器会话配置为远程 CDP 浏览器。",
        openclawConfig: "在 OpenClaw 配置中设置",
        openclawHint: "会话在浏览器窗口保持活跃期间持续有效。Token 随会话刷新而更新，请确保在 Agent 启动前获取最新的 CDP 地址。",
        claudeIntro: "通过 MCP 将此浏览器接入 Claude Code，让 Claude 可以直接操控浏览器。",
        claudeConfig: "在 .claude/settings.json 中添加 MCP 服务器",
        claudeHint: "需要安装 @playwright/mcp。此 Token 为临时凭证，每次会话重启后需重新获取。",
        cursorIntro: "在 Cursor 中通过 MCP 连接此浏览器，让 AI 具备浏览器操控能力。",
        cursorConfig: "在 Cursor 设置 → MCP 中添加",
        cursorHint: "配置完成后重启 Cursor，在对话中即可要求 AI 控制浏览器执行操作。",
        customIntro: "通过 CDP（Chrome DevTools Protocol）直接接入此浏览器会话。",
        playwrightNode: "Playwright（Node.js）",
        playwrightPython: "Playwright（Python）",
        customApi: "自定义 / API",
        copy: "复制",
      },
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
