import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  LayoutDashboard,
  LogOut,
  Monitor,
  Users,
} from "lucide-react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import browsermintIcon from "../assets/browsermint-icon.png";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";
import { sessionsApi } from "../api/client.ts";

const AVATAR_TONES = ["#7e6a55", "#177b65", "#345c7c", "#945f3c", "#6f5978", "#8a4d57"];

function getAvatarTone(seed: string) {
  const hash = seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export default function Layout() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const { locale, setLocale, t, formatDateTime } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [langSubmenuOpen, setLangSubmenuOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list().then((res) => res.data.sessions),
    refetchInterval: 30000,
  });
  const sessions = data ?? [];

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setLangSubmenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const navItems = useMemo(
    () => [
      {
        path: "/",
        label: t("nav.overview"),
        icon: LayoutDashboard,
        description: t("layout.pageDescriptions.overview"),
        exact: true,
      },
      {
        path: "/browsers",
        label: t("nav.browsers"),
        icon: Monitor,
        description: t("layout.pageDescriptions.browsers"),
        exact: false,
      },
    ],
    [t]
  );

  const adminNavItems = user?.isAdmin
    ? [
        {
          path: "/admin/users",
          label: t("nav.adminUsers"),
          icon: Users,
          description: t("layout.pageDescriptions.adminUsers"),
          exact: false,
        },
        {
          path: "/admin/sessions",
          label: t("nav.adminSessions"),
          icon: Activity,
          description: t("layout.pageDescriptions.adminSessions"),
          exact: false,
        },
      ]
    : [];

  function isActive(path: string, exact: boolean) {
    if (exact) return location.pathname === path;
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  }

  const allNavItems = [...navItems, ...adminNavItems];
  const currentItem = allNavItems.find((item) => isActive(item.path, item.exact)) ?? navItems[0];
  const avatarInitial = (user?.username?.[0] ?? "?").toUpperCase();
  const avatarTone = getAvatarTone(user?.username ?? "browsermint");
  const maxSessions = user?.maxSessions ?? 0;
  const unlimited = maxSessions === 0;
  const usage = unlimited ? 0 : Math.min(100, Math.round((sessions.length / maxSessions) * 100));

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[rgba(255,255,255,0.92)] shadow-sm ring-1 ring-[var(--line-soft)]">
            <img src={browsermintIcon} alt="Browsermint" className="h-8 w-8 object-contain" />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--text-strong)]">{t("common.appName")}</div>
            <div className="text-xs text-[var(--text-soft)]">{t("layout.sidebarTagline")}</div>
          </div>
        </div>

        <div className="px-4 pb-3">
          <div className="surface-card px-4 py-4">
            <div className="subtle-label">{t("sidebar.usage")}</div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className="data-value text-[28px]">{sessions.length}</div>
                <div className="mt-1 text-xs text-[var(--text-soft)]">{t("sidebar.usageBrowsers")}</div>
              </div>
              <div className="rounded-full bg-[var(--bg-soft)] px-3 py-1 text-xs font-medium text-[var(--text-main)]">
                {sessions.length}/{unlimited ? "∞" : maxSessions}
              </div>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[rgba(34,29,23,0.08)]">
              <div className="h-full rounded-full bg-[var(--brand-main)] transition-all" style={{ width: `${usage}%` }} />
            </div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          {navItems.map(({ path, label, icon: Icon, exact }) => {
            const active = isActive(path, exact);
            return (
              <Link
                key={path}
                to={path}
                className={clsx(
                  "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition-all",
                  active
                    ? "bg-[var(--bg-panel)] text-[var(--text-strong)] shadow-sm ring-1 ring-[var(--brand-soft-strong)]"
                    : "text-[var(--text-main)] hover:bg-[rgba(255,255,255,0.55)] hover:text-[var(--text-strong)]"
                )}
              >
                <span
                  className={clsx(
                    "flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
                    active ? "bg-[var(--brand-soft)] text-[var(--brand-strong)]" : "bg-transparent text-[var(--text-soft)]"
                  )}
                >
                  <Icon size={17} strokeWidth={1.8} />
                </span>
                <span className="truncate font-medium">{label}</span>
              </Link>
            );
          })}

          {adminNavItems.length > 0 && (
            <>
              <div className="mx-4 my-3 h-px bg-[var(--line-soft)]" />
              <div className="px-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
                {t("layout.adminSection")}
              </div>
              {adminNavItems.map(({ path, label, icon: Icon, exact }) => {
                const active = isActive(path, exact);
                return (
                  <Link
                    key={path}
                    to={path}
                    className={clsx(
                      "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition-all",
                      active
                        ? "bg-[var(--bg-panel)] text-[var(--text-strong)] shadow-sm ring-1 ring-[var(--brand-soft-strong)]"
                        : "text-[var(--text-main)] hover:bg-[rgba(255,255,255,0.55)] hover:text-[var(--text-strong)]"
                    )}
                  >
                    <span
                      className={clsx(
                        "flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
                        active ? "bg-[var(--brand-soft)] text-[var(--brand-strong)]" : "bg-transparent text-[var(--text-soft)]"
                      )}
                    >
                      <Icon size={17} strokeWidth={1.8} />
                    </span>
                    <span className="truncate font-medium">{label}</span>
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        <div className="relative px-4 pb-5" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((open) => !open)}
            className="flex w-full items-center gap-3 rounded-2xl bg-[rgba(255,255,255,0.7)] px-3 py-3 text-left ring-1 ring-[var(--line-soft)] transition hover:bg-[rgba(255,255,255,0.9)]"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl text-sm font-semibold text-white" style={{ backgroundColor: avatarTone }}>
              {avatarInitial}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--text-strong)]">{user?.username}</div>
              <div className="truncate text-xs text-[var(--text-soft)]">{user?.email}</div>
            </div>
            <ChevronDown size={16} className="text-[var(--text-soft)]" />
          </button>

          {menuOpen && (
            <div className="surface-card-strong absolute bottom-full left-0 right-0 z-20 mb-2 p-2">
              <div className="rounded-2xl px-3 py-3">
                <div className="text-sm font-medium text-[var(--text-strong)]">{user?.username}</div>
                <div className="mt-1 text-xs text-[var(--text-soft)]">{user?.email}</div>
                <div className="mt-2 text-xs text-[var(--text-faint)]">
                  {t("user.joinedAt")}: {user?.createdAt ? formatDateTime(user.createdAt) : "-"}
                </div>
              </div>
              <div className="mx-2 h-px bg-[var(--line-soft)]" />
              <div
                className="relative px-2 py-1"
                onMouseEnter={() => setLangSubmenuOpen(true)}
                onMouseLeave={() => setLangSubmenuOpen(false)}
              >
                <button className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--text-main)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-strong)]">
                  <Globe size={15} />
                  <span className="flex-1 text-left">{t("common.language")}</span>
                  <span className="mr-1 text-xs text-[var(--text-soft)]">{locale === "zh" ? t("common.chinese") : t("common.english")}</span>
                  <ChevronRight size={13} className="text-[var(--text-soft)]" />
                </button>
                {langSubmenuOpen && (
                  <div className="surface-card-strong absolute bottom-0 left-full z-30 ml-1 w-36 p-1">
                    {(["en", "zh"] as const).map((nextLocale) => {
                      const active = nextLocale === locale;
                      return (
                        <button
                          key={nextLocale}
                          onClick={() => {
                            setLocale(nextLocale);
                            setMenuOpen(false);
                            setLangSubmenuOpen(false);
                          }}
                          className={clsx(
                            "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition",
                            active
                              ? "bg-[var(--brand-soft)] text-[var(--brand-strong)]"
                              : "text-[var(--text-main)] hover:bg-[var(--bg-soft)]"
                          )}
                        >
                          <span>{nextLocale === "zh" ? t("common.chinese") : t("common.english")}</span>
                          {active && <Check size={14} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="mx-2 h-px bg-[var(--line-soft)]" />
              <div className="p-2">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    logout();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--text-main)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-strong)]"
                >
                  <LogOut size={15} />
                  {t("common.signOut")}
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="app-main">
        <div className="px-4 pt-4 sm:px-6 lg:px-8">
          <div className="topbar-panel px-4 py-4 sm:px-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[rgba(255,255,255,0.92)] shadow-sm ring-1 ring-[var(--line-soft)] lg:hidden">
                <img src={browsermintIcon} alt="Browsermint" className="h-8 w-8 object-contain" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--brand-strong)]">{currentItem.label}</div>
                <div className="mt-1 text-sm text-[var(--text-soft)]">{currentItem.description}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 pt-4 sm:px-6 lg:hidden">
          <div className="surface-panel px-3 py-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {allNavItems.map(({ path, label, exact }) => {
                const active = isActive(path, exact);
                return (
                  <Link
                    key={path}
                    to={path}
                    className={clsx(
                      "whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition",
                      active
                        ? "bg-[var(--text-strong)] text-white"
                        : "bg-[rgba(255,255,255,0.86)] text-[var(--text-main)] ring-1 ring-[var(--line-soft)]"
                    )}
                  >
                    {label}
                  </Link>
                );
              })}
            </div>
            <div className="mt-3 flex flex-col gap-3 rounded-2xl bg-[rgba(255,253,249,0.86)] px-4 py-4 ring-1 ring-[var(--line-soft)] sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--text-strong)]">{user?.username}</div>
                <div className="truncate text-xs text-[var(--text-soft)]">{user?.email}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(["en", "zh"] as const).map((nextLocale) => {
                  const active = locale === nextLocale;
                  return (
                    <button
                      key={nextLocale}
                      onClick={() => setLocale(nextLocale)}
                      className={clsx(
                        "rounded-full px-3 py-2 text-xs font-medium transition",
                        active
                          ? "bg-[var(--brand-soft)] text-[var(--brand-strong)]"
                          : "bg-[var(--bg-soft)] text-[var(--text-main)]"
                      )}
                    >
                      {nextLocale === "zh" ? t("common.chinese") : t("common.english")}
                    </button>
                  );
                })}
                <button onClick={logout} className="button-secondary px-3 py-2 text-xs">
                  <LogOut size={14} />
                  {t("common.signOut")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <Outlet />
      </main>
    </div>
  );
}
