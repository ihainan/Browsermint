import type { Session } from "../api/client.ts";
import type { Locale } from "./I18nContext.tsx";

const statusLabels: Record<Locale, Record<Session["status"], string>> = {
  en: {
    creating: "creating",
    running: "running",
    stopping: "stopping",
    stopped: "stopped",
    error: "error",
    paused: "paused",
  },
  zh: {
    creating: "创建中",
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    error: "错误",
    paused: "已暂停",
  },
};

export function getSessionStatusLabel(locale: Locale, status: Session["status"]): string {
  return statusLabels[locale][status];
}
