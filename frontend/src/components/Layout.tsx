import { useState, useRef, useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Monitor, LayoutDashboard, Key, LogOut, ChevronDown, Check, Users, Activity } from "lucide-react";
import browsermintIcon from "../assets/browsermint-icon.png";
import clsx from "clsx";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { useQuery } from "@tanstack/react-query";
import { sessionsApi } from "../api/client.ts";

const AVATAR_COLORS = [
  "bg-red-500", "bg-orange-500", "bg-amber-500", "bg-yellow-500",
  "bg-lime-600", "bg-green-500", "bg-teal-500", "bg-cyan-500",
  "bg-sky-500", "bg-blue-500", "bg-indigo-500", "bg-violet-500",
  "bg-purple-500", "bg-fuchsia-500", "bg-pink-500", "bg-rose-500",
];

function getAvatarColor(username: string): string {
  const hash = username.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Browserbase bedrock color — used for sidebar + content header
const BG_BEDROCK = "bg-[#f6f5f5]";
// Dashed decorative border color
const DASHED_BORDER = "border-dashed border-[#C5D3E8]";

export default function Layout() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const { locale, setLocale, t, formatDateTime } = useI18n();

  const [userOpen, setUserOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list().then((r) => r.data.sessions),
    refetchInterval: 30000,
  });
  const sessions = data ?? [];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserOpen(false);
        setLanguageOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const avatarColor = getAvatarColor(user?.username ?? "");
  const avatarInitial = (user?.username?.[0] ?? "?").toUpperCase();

  const navItems = [
    { path: "/", label: t("nav.overview"), icon: LayoutDashboard, exact: true },
    { path: "/browsers", label: t("nav.browsers"), icon: Monitor, exact: false },
    // { path: "/api-key", label: t("nav.apiKey"), icon: Key, exact: true },
  ];

  const adminNavItems = user?.isAdmin
    ? [
        { path: "/admin/users", label: t("nav.adminUsers"), icon: Users, exact: false },
        { path: "/admin/sessions", label: t("nav.adminSessions"), icon: Activity, exact: false },
      ]
    : [];

  function isNavActive(path: string, exact: boolean) {
    if (exact) return location.pathname === path;
    return location.pathname === path || location.pathname.startsWith(path + "/");
  }

  const pageTitleMap: Record<string, string> = {
    "/": t("nav.overview"),
    "/browsers": t("nav.browsers"),
    "/api-key": t("nav.apiKey"),
    "/admin/users": t("nav.adminUsers"),
    "/admin/sessions": t("nav.adminSessions"),
  };
  const pageTitle = pageTitleMap[location.pathname] ?? "";

  const maxSessions = user?.maxSessions ?? 5;
  const usagePct = Math.min(100, Math.round((sessions.length / maxSessions) * 100));

  return (
    <div className="flex h-screen">
      {/* ── Sidebar ── */}
      <aside
        className={clsx(
          "w-[264px] flex flex-col shrink-0 border-r",
          BG_BEDROCK,
          DASHED_BORDER
        )}
      >
        {/* Logo header */}
        <div
          className={clsx(
            "flex h-[52px] shrink-0 items-center border-b px-4 gap-2",
            DASHED_BORDER
          )}
        >
          <img src={browsermintIcon} alt="Browsermint" className="w-8 h-8 rounded-md shrink-0" />
          <span className="text-[15px] font-semibold text-[#260f17] tracking-tight">Browsermint</span>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2 space-y-0.5">
          {navItems.map(({ path, label, icon: Icon, exact }) => (
            <Link
              key={path}
              to={path}
              className={clsx(
                "flex w-full items-center gap-2 rounded-sm p-2 text-left text-sm h-8 transition-colors",
                isNavActive(path, exact)
                  ? "bg-[#1dc99a18] text-[#0d7a5f] font-medium"
                  : "text-[#514f4f] hover:bg-[#260f170f] hover:text-[#260f17]"
              )}
            >
              <Icon size={16} strokeWidth={1.75} className="shrink-0" />
              {label}
            </Link>
          ))}
        </nav>

        {/* Admin section */}
        {adminNavItems.length > 0 && (
          <div className="px-2">
            <div className={clsx("border-t mx-1 mb-2", DASHED_BORDER)} />
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-[#cac8c7]">
              Admin
            </p>
            <div className="space-y-0.5">
              {adminNavItems.map(({ path, label, icon: Icon, exact }) => (
                <Link
                  key={path}
                  to={path}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-sm p-2 text-left text-sm h-8 transition-colors",
                    isNavActive(path, exact)
                      ? "bg-[#1dc99a18] text-[#0d7a5f] font-medium"
                      : "text-[#514f4f] hover:bg-[#260f170f] hover:text-[#260f17]"
                  )}
                >
                  <Icon size={16} strokeWidth={1.75} className="shrink-0" />
                  {label}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom */}
        <div className="px-2 pb-3">
          {/* User */}
          <div ref={userRef} className="relative">
            <button
              onClick={() => {
                setUserOpen((o) => !o);
                setLanguageOpen(false);
              }}
              className="w-full flex items-center gap-2 rounded-sm p-2 h-8 text-sm text-[#514f4f] hover:bg-[#260f170f] hover:text-[#260f17] transition-colors"
            >
              <div
                className={clsx(
                  "w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0",
                  avatarColor
                )}
              >
                {avatarInitial}
              </div>
              <span className="truncate">{user?.username}</span>
            </button>

            {userOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-72 bg-white rounded-xl shadow-xl ring-[0.5px] ring-black/[0.07] z-50 overflow-hidden">
                <div className="p-4 flex items-center gap-3">
                  <div
                    className={clsx(
                      "w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0",
                      avatarColor
                    )}
                  >
                    {avatarInitial}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[#260f17]">{user?.username}</p>
                    <p className="text-xs text-[#969493] truncate">{user?.email}</p>
                    <p className="text-xs text-[#cac8c7] mt-0.5">
                      {t("user.joinedAt")}: {user?.createdAt ? formatDateTime(user.createdAt) : "—"}
                    </p>
                  </div>
                </div>

                <div className="h-px bg-[#edebeb]" />

                {/* Usage */}
                <div className="px-4 py-3">
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-[12px] text-[#969493]">{t("sidebar.usageBrowsers")}</span>
                    <span className="text-[12px] font-medium text-[#260f17]">
                      {sessions.length} / {maxSessions}
                    </span>
                  </div>
                  <div className="h-1 bg-[#edebeb] rounded-full overflow-hidden">
                    <div
                      className={clsx(
                        "h-full rounded-full transition-all",
                        usagePct >= 90 ? "bg-red-500" : usagePct >= 70 ? "bg-amber-500" : "bg-[#1dc99a]"
                      )}
                      style={{ width: `${usagePct}%` }}
                    />
                  </div>
                </div>

                <div className="h-px bg-[#edebeb]" />

                <div className="p-1">
                  <button
                    onClick={() => setLanguageOpen((o) => !o)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[13px] text-[#514f4f] hover:bg-[#f6f5f5] rounded-sm transition-colors"
                  >
                    <span>{t("common.language")}</span>
                    <ChevronDown
                      size={13}
                      className={clsx(
                        "text-[#969493] transition-transform duration-150",
                        languageOpen ? "rotate-0" : "-rotate-90"
                      )}
                    />
                  </button>
                  {languageOpen && (
                    <div className="mt-0.5 mx-1 bg-[#fafafa] rounded-sm overflow-hidden">
                      {(["en", "zh"] as const).map((nextLocale) => (
                        <button
                          key={nextLocale}
                          onClick={() => {
                            setLocale(nextLocale);
                            setLanguageOpen(false);
                          }}
                          className="w-full flex items-center justify-between gap-2 px-4 py-2 text-[13px] text-[#514f4f] hover:bg-[#edebeb] transition-colors"
                        >
                          <span>{nextLocale === "zh" ? t("common.chinese") : t("common.english")}</span>
                          {locale === nextLocale && <Check size={13} className="text-[#260f17]" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="h-px bg-[#edebeb]" />

                <div className="p-1">
                  <button
                    onClick={() => { setUserOpen(false); logout(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#514f4f] hover:bg-[#f6f5f5] rounded-sm transition-colors"
                  >
                    <LogOut size={14} />
                    {t("common.signOut")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ── Content area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Page header — same bedrock bg as sidebar */}
        <header
          className={clsx(
            "flex h-[52px] shrink-0 items-center border-b px-4",
            BG_BEDROCK,
            DASHED_BORDER
          )}
        >
          <h1 className="text-[13px] font-normal text-[#260f17]">{pageTitle}</h1>
        </header>

        {/* Page content — white bg */}
        <main className="flex-1 overflow-y-auto bg-white">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
