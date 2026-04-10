import { Link, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ChevronRight, Copy, Check, AlertTriangle } from "lucide-react";
import clsx from "clsx";
import { useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { TooltipProps } from "recharts";
import { sessionsApi, Session } from "../api/client.ts";
import { useI18n } from "../i18n/I18nContext.tsx";
import { getSessionStatusLabel } from "../i18n/sessionStatus.ts";

function StatusBadge({ status }: { status: Session["status"] }) {
  const { locale } = useI18n();

  const styles: Record<Session["status"], string> = {
    running:  "ring-green-600/20  bg-green-600/10  text-green-600",
    stopped:  "ring-black/10      bg-black/5       text-[var(--text-main)]",
    creating: "ring-amber-600/20  bg-amber-600/10  text-amber-600",
    stopping: "ring-orange-600/20 bg-orange-600/10 text-orange-600",
    error:    "ring-red-600/20    bg-red-600/10    text-red-600",
    paused:   "ring-blue-600/20   bg-blue-600/10   text-blue-600",
  };

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-normal ring-[0.5px] ring-inset capitalize",
        styles[status]
      )}
    >
      {(status === "creating" || status === "stopping") && (
        <Loader2 size={10} className="animate-spin shrink-0 mr-0.5" />
      )}
      {getSessionStatusLabel(locale, status)}
    </span>
  );
}

export { StatusBadge };

function IdCell({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[13px] text-[var(--text-strong)]">{id.slice(0, 8)}…</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(id).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="text-[var(--text-faint)] hover:text-[var(--text-soft)] transition-colors"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

function ChartTooltip(props: TooltipProps<number, string>) {
  const { active, payload, label } = props as {
    active?: boolean;
    payload?: { value: number }[];
    label?: string;
  };
  if (!active || !payload?.length) return null;
  return (
    <div className="surface-card-strong px-3 py-2 text-[12px]">
      <p className="mb-1 text-[var(--text-soft)]">{label}</p>
      <div className="flex items-center gap-1.5 leading-5">
        <span className="inline-block w-2 h-2 rounded-sm bg-[var(--brand-main)] shrink-0" />
        <span className="font-medium text-[var(--text-strong)]">{payload[0].value}</span>
      </div>
    </div>
  );
}

const EXPIRY_WARNING_DAYS = 30;

export function daysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export default function OverviewPage() {
  const { t, formatDateTime } = useI18n();

  const { data, isPending } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list().then((r) => r.data.sessions),
    refetchInterval: 10000,
  });
  const sessions = data ?? [];

  const { data: statsData } = useQuery({
    queryKey: ["eventsStats"],
    queryFn: () => sessionsApi.getEventsStats().then((r) => r.data),
    refetchInterval: 60000,
  });

  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const agentEvents = statsData?.agentEventCount ?? 0;

  const stats = [
    { label: t("overview.totalBrowsers"),   value: sessions.length },
    { label: t("overview.runningBrowsers"), value: sessions.filter((s) => s.status === "running").length },
    { label: t("overview.idleBrowsers"),    value: sessions.filter((s) => s.status === "paused").length },
    { label: t("overview.stoppedBrowsers"), value: sessions.filter((s) => s.status === "stopped").length },
    { label: t("overview.agentEvents"),     value: formatCount(agentEvents) },
  ];

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dailyData = useMemo(() => {
    const map = new Map(statsData?.dailyCounts.map((d) => [d.date, d]) ?? []);
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - i));
      const key = date.toISOString().slice(0, 10);
      const label = `${DAY_NAMES[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`;
      const entry = map.get(key);
      const agentCount = entry?.agentCount ?? 0;
      const total = entry?.count ?? 0;
      return { date: key, label, agentCount, otherCount: total - agentCount };
    });
  }, [statsData]);

  const hourlyData = useMemo(() => {
    const tzOffsetHours = -new Date().getTimezoneOffset() / 60;
    const localMap = new Map<number, number>();
    const localAgentMap = new Map<number, number>();
    for (const { hour, count, agentCount } of statsData?.hourlyDistribution ?? []) {
      const localHour = ((hour + tzOffsetHours) % 24 + 24) % 24;
      localMap.set(localHour, (localMap.get(localHour) ?? 0) + count);
      localAgentMap.set(localHour, (localAgentMap.get(localHour) ?? 0) + agentCount);
    }
    const currentHour = new Date().getHours();
    return Array.from({ length: 24 }, (_, i) => {
      const hour = (currentHour - 23 + i + 24) % 24;
      const total = localMap.get(hour) ?? 0;
      const agentCount = localAgentMap.get(hour) ?? 0;
      return {
        hour,
        label: `${hour.toString().padStart(2, "0")}:00`,
        agentCount,
        otherCount: total - agentCount,
      };
    });
  }, [statsData]);

  // Redirect to /browsers when there are no sessions yet (e.g. first login).
  // Must be after all hooks.
  if (data !== undefined && sessions.length === 0) {
    return <Navigate to="/browsers" replace />;
  }

  const hasEvents = agentEvents > 0;

  const expiringSoonCount = sessions.filter((s) => {
    const days = daysUntilExpiry(s.expiresAt);
    return days !== null && days <= EXPIRY_WARNING_DAYS;
  }).length;

  const tableHeaders = [
    t("browsers.filterStatus"),
    t("browsers.browserId"),
    t("browsers.name"),
    t("browsers.started"),
    t("browsers.lastActive"),
    t("browsers.expiresAt"),
  ];

  return (
    <div className="page-wrap flex flex-col gap-y-8">

      {/* ── Expiring soon banner ── */}
      {expiringSoonCount > 0 && (
        <div
          className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
          style={{ background: "var(--warning-soft)", borderColor: "rgba(181, 122, 31, 0.22)" }}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="shrink-0" style={{ color: "var(--warning-main)" }} />
            <span className="text-[13px]" style={{ color: "var(--warning-main)" }}>
              {t("overview.expiringSoon", { count: expiringSoonCount })}
            </span>
          </div>
          <Link
            to="/browsers"
            className="text-[13px] font-medium whitespace-nowrap transition-opacity hover:opacity-70"
            style={{ color: "var(--warning-main)" }}
          >
            {t("overview.expiringSoonLink")} →
          </Link>
        </div>
      )}

      {/* ── Recent browsers ── */}
      <section>
        <header className="mb-4 flex items-baseline justify-between px-1">
          <h2 className="text-[15px] font-medium text-[var(--text-strong)]">
            {t("overview.recentBrowsers")}
          </h2>
          <Link
            to="/browsers"
            className="inline-flex items-center gap-1 text-[13px] text-[var(--text-soft)] hover:text-[var(--text-strong)] px-2 py-1 rounded-md transition-colors"
          >
            {t("overview.viewAll")}
            <ChevronRight size={14} />
          </Link>
        </header>

        {isPending && sessions.length === 0 ? (
          <div className="flex justify-center py-10">
            <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" />
          </div>
        ) : recentSessions.length === 0 ? (
          <p className="px-1 text-[13px] text-[var(--text-soft)]">{t("overview.noBrowsersYet")}</p>
        ) : (
          <div className="surface-card-strong overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 table-auto text-[13px] text-[var(--text-strong)]">
                <thead>
                  <tr>
                    {tableHeaders.map((h) => (
                      <th
                        key={h}
                        className="px-3 py-3 text-left text-xs font-normal text-[var(--text-faint)]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((session) => (
                    <tr
                      key={session.id}
                      className={clsx(
                        "border-t transition-colors",
                        (session.status === "running" || session.status === "paused")
                          ? "cursor-pointer hover:bg-[var(--bg-soft)]"
                          : "hover:bg-[var(--bg-soft)]"
                      )}
                      style={{ borderColor: "var(--line-soft)" }}
                      onClick={() =>
                        (session.status === "running" || session.status === "paused") &&
                        window.open(`/sessions/${session.id}`, "_blank")
                      }
                    >
                      <td className="p-0 w-[10%]">
                        <div className="flex h-12 items-center px-3">
                          <StatusBadge status={session.status} />
                        </div>
                      </td>
                      <td className="p-0 w-[20%]">
                        <div className="flex h-12 items-center px-3">
                          <IdCell id={session.id} />
                        </div>
                      </td>
                      <td className="p-0">
                        <div className="flex h-12 items-center px-3 text-[var(--text-strong)]">
                          {session.name ?? <span className="text-[var(--text-faint)]">—</span>}
                        </div>
                      </td>
                      <td className="p-0 whitespace-nowrap">
                        <div className="flex h-12 items-center px-3 text-[var(--text-main)]">
                          {formatDateTime(session.createdAt)}
                        </div>
                      </td>
                      <td className="p-0 whitespace-nowrap">
                        <div className="flex h-12 items-center px-3 text-[var(--text-main)]">
                          {formatDateTime(session.lastActiveAt)}
                        </div>
                      </td>
                      <td className="p-0 whitespace-nowrap">
                        <div className="flex h-12 items-center px-3">
                          {(() => {
                            const days = daysUntilExpiry(session.expiresAt);
                            if (days === null) return <span className="text-[var(--text-faint)]">—</span>;
                            if (days <= 0) return <span className="font-medium text-red-500">Expired</span>;
                            if (days <= EXPIRY_WARNING_DAYS) return <span className="text-amber-600">{formatDateTime(session.expiresAt!)}</span>;
                            return <span className="text-[var(--text-main)]">{formatDateTime(session.expiresAt!)}</span>;
                          })()}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ── Analytics ── */}
      <section>
        <header className="mb-5 flex items-center px-1">
          <h2 className="text-[15px] font-medium text-[var(--text-strong)]">
            {t("overview.analyticsTitle")}
          </h2>
        </header>

        <div className="flex flex-col gap-4">

          {/* Stats row */}
          <div className="surface-card-strong overflow-hidden">
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x"
              style={{ borderColor: "var(--line-soft)" }}
            >
              {stats.map(({ label, value }) => (
                <div
                  key={label}
                  className="flex items-center justify-between sm:flex-col sm:items-start sm:gap-y-1.5 px-5 py-4 sm:py-5"
                >
                  <h3 className="text-[12px] text-[var(--text-soft)]">{label}</h3>
                  <p className="text-[28px] font-normal leading-none text-[var(--text-strong)] sm:mt-0">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="surface-card px-5 pt-4 pb-3">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-[13px] font-medium text-[var(--text-strong)]">
                  {t("overview.dailyEvents")}
                </h3>
                <span className="text-[11px] text-[var(--text-faint)]">
                  {t("overview.dailyEventsSubtitle")}
                </span>
              </div>
              {!hasEvents ? (
                <div className="flex items-center justify-center h-[160px]">
                  <p className="text-[13px] text-[var(--text-soft)]">{t("overview.noEventsYet")}</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={dailyData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="35%">
                    <CartesianGrid vertical={false} stroke="var(--line-soft)" strokeDasharray="0" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={28}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--bg-soft)" }} />
                    <Bar dataKey="agentCount" fill="var(--brand-main)" radius={[2, 2, 0, 0]} maxBarSize={32} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="surface-card px-5 pt-4 pb-3">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-[13px] font-medium text-[var(--text-strong)]">
                  {t("overview.hourlyActivity")}
                </h3>
                <span className="text-[11px] text-[var(--text-faint)]">
                  {t("overview.hourlyActivitySubtitle")}
                </span>
              </div>
              {!hasEvents ? (
                <div className="flex items-center justify-center h-[160px]">
                  <p className="text-[13px] text-[var(--text-soft)]">{t("overview.noEventsYet")}</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={hourlyData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke="var(--line-soft)" strokeDasharray="0" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                      tickLine={false}
                      axisLine={false}
                      interval={3}
                      tickFormatter={(v: string) => v.slice(0, 2)}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={28}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--bg-soft)" }} />
                    <Bar dataKey="agentCount" fill="var(--brand-main)" radius={[2, 2, 0, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Capsolver stats */}
          {statsData && (statsData.capsolver.total > 0 || true) && (
            <div className="surface-card px-5 py-4">
              <div className="mb-4">
                <h3 className="text-[13px] font-medium text-[var(--text-strong)]">
                  {t("overview.capsolverTitle")}
                </h3>
              </div>
              {statsData.capsolver.total === 0 ? (
                <p className="text-[13px] text-[var(--text-soft)]">{t("overview.capsolverNoData")}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">Total</span>
                    <span className="text-[24px] font-normal leading-none text-[var(--text-strong)]">
                      {formatCount(statsData.capsolver.total)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{t("overview.capsolverSuccess")}</span>
                    <span className="text-[24px] font-normal text-green-600 leading-none">
                      {formatCount(statsData.capsolver.success)}
                    </span>
                    {statsData.capsolver.total > 0 && (
                      <span className="text-[11px] text-[var(--text-faint)]">
                        {Math.round((statsData.capsolver.success / statsData.capsolver.total) * 100)}%
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{t("overview.capsolverFailed")}</span>
                    <span className={clsx(
                      "text-[24px] font-normal leading-none",
                      statsData.capsolver.failed > 0 ? "text-red-500" : "text-[var(--text-strong)]"
                    )}>
                      {formatCount(statsData.capsolver.failed)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{t("overview.capsolverAvgTime")}</span>
                    <span className="text-[24px] font-normal leading-none text-[var(--text-strong)]">
                      {statsData.capsolver.avgDurationMs != null
                        ? statsData.capsolver.avgDurationMs >= 60000
                          ? `${Math.round(statsData.capsolver.avgDurationMs / 60000)}m`
                          : `${Math.round(statsData.capsolver.avgDurationMs / 1000)}s`
                        : "—"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </section>
    </div>
  );
}
