import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ChevronRight, Copy, Check } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { sessionsApi, Session } from "../api/client.ts";
import { useI18n } from "../i18n/I18nContext.tsx";
import { getSessionStatusLabel } from "../i18n/sessionStatus.ts";

// Status badge matching Browserbase ring-inset approach
function StatusBadge({ status }: { status: Session["status"] }) {
  const { locale } = useI18n();

  const styles: Record<Session["status"], string> = {
    running:  "ring-green-600/20  bg-green-600/10  text-green-700",
    stopped:  "ring-black/10      bg-black/5       text-[#514f4f]",
    creating: "ring-amber-600/20  bg-amber-600/10  text-amber-700",
    stopping: "ring-orange-600/20 bg-orange-600/10 text-orange-700",
    error:    "ring-red-600/20    bg-red-600/10    text-red-700",
  };

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-normal ring-[0.5px] ring-inset",
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
      <span className="font-mono text-[13px] text-[#260f17]">{id.slice(0, 8)}…</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(id).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="text-[#969493] hover:text-[#514f4f] transition-colors"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

export default function OverviewPage() {
  const { t, formatDateTime } = useI18n();

  const { data, isPending } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list().then((r) => r.data.sessions),
    refetchInterval: 10000,
  });
  const sessions = data ?? [];

  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const stats = [
    { label: t("overview.totalBrowsers"),   value: sessions.length },
    { label: t("overview.runningBrowsers"), value: sessions.filter((s) => s.status === "running").length },
    { label: t("overview.stoppedBrowsers"), value: sessions.filter((s) => s.status === "stopped").length },
    { label: t("overview.errorBrowsers"),   value: sessions.filter((s) => s.status === "error").length },
  ];

  return (
    <div className="mx-auto w-full max-w-screen-2xl flex flex-col gap-y-10 px-4 pt-5 pb-12">

      {/* ── Recent browsers ── */}
      <section>
        <header className="mb-4 flex items-baseline justify-between px-2">
          <h2 className="text-[15px] font-medium text-[#260f17]">
            {t("overview.recentBrowsers")}
          </h2>
          <Link
            to="/browsers"
            className="inline-flex items-center gap-1 text-[13px] text-[#260f17] hover:bg-[#260f170f] px-2 py-1 rounded-sm transition-colors"
          >
            {t("overview.viewAll")}
            <ChevronRight size={14} />
          </Link>
        </header>

        {isPending && sessions.length === 0 ? (
          <div className="flex justify-center py-10">
            <Loader2 size={18} className="animate-spin text-[#cac8c7]" />
          </div>
        ) : recentSessions.length === 0 ? (
          <p className="px-2 text-[13px] text-[#969493]">{t("overview.noBrowsersYet")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-[#260f17] text-[13px] w-full border-separate border-spacing-0 table-auto">
              <thead>
                <tr>
                  {[
                    t("browsers.filterStatus"),
                    t("browsers.browserId"),
                    t("browsers.name"),
                    t("browsers.started"),
                    t("browsers.lastActive"),
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-[#969493] text-xs px-2 pb-2 text-left font-normal"
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
                      "border-t border-[#edebeb] transition-colors",
                      session.status === "running" && "hover:bg-[#fafafa] cursor-pointer"
                    )}
                    onClick={() =>
                      session.status === "running" &&
                      window.open(`/sessions/${session.id}`, "_blank")
                    }
                  >
                    <td className="p-0 w-[10%]">
                      <div className="flex h-12 items-center px-2">
                        <StatusBadge status={session.status} />
                      </div>
                    </td>
                    <td className="p-0 w-[20%]">
                      <div className="flex h-12 items-center px-2">
                        <IdCell id={session.id} />
                      </div>
                    </td>
                    <td className="p-0">
                      <div className="flex h-12 items-center px-2 text-[#260f17]">
                        {session.name ?? <span className="text-[#cac8c7]">—</span>}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-2 text-[#514f4f]">
                        {formatDateTime(session.createdAt)}
                      </div>
                    </td>
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-2 text-[#514f4f]">
                        {formatDateTime(session.lastActiveAt)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Analytics ── */}
      <section>
        <header className="flex items-center gap-x-3 mb-4 px-2">
          <h2 className="text-[15px] font-medium text-[#260f17]">
            {t("overview.analyticsTitle")}
          </h2>
        </header>

        {/* Stats — single container, border-r separators, matching Browserbase exactly */}
        <section className="border border-[#edebeb] overflow-hidden rounded-lg p-0 bg-white">
          <div className="grid grid-cols-1 gap-px bg-white sm:grid-cols-2 lg:grid-cols-4">
            {stats.map(({ label, value }, i) => (
              <div
                key={label}
                className={clsx(
                  "flex items-center justify-between border-b border-[#edebeb] bg-white px-4 py-3",
                  "sm:flex-col sm:items-center sm:justify-center sm:gap-y-1 sm:border-r sm:py-5 sm:text-center",
                  "last:border-b-0 lg:border-b-0",
                  i === stats.length - 1 && "sm:border-r-0"
                )}
              >
                <h3 className="text-[13px] text-[#514f4f]">{label}</h3>
                <p className="text-[28px] font-normal text-[#260f17] leading-none sm:mt-1">
                  {value}
                </p>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
