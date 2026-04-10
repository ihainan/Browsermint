import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import browsermintIcon from "../assets/browsermint-icon.png";
import { useI18n } from "../i18n/I18nContext.tsx";

function LanguageMenu() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-[var(--text-soft)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-main)]"
      >
        <Globe size={14} />
        <span>{locale === "zh" ? t("common.chinese") : t("common.english")}</span>
      </button>
      {open && (
        <div className="surface-card-strong absolute right-0 top-full z-50 mt-1 w-32 p-1">
          {(["en", "zh"] as const).map((l) => (
            <button
              key={l}
              onClick={() => { setLocale(l); setOpen(false); }}
              className={`flex w-full items-center rounded-lg px-3 py-2 text-sm transition hover:bg-[var(--bg-soft)] ${
                locale === l ? "font-medium text-[var(--text-strong)]" : "text-[var(--text-main)]"
              }`}
            >
              {l === "zh" ? t("common.chinese") : t("common.english")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AuthShell({
  children,
  title,
  subtitle,
  eyebrow,
  gridCols = "lg:grid-cols-[1.12fr_0.88fr]",
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  eyebrow: string;
  gridCols?: string;
}) {
  const { t } = useI18n();

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
        <LanguageMenu />
      </div>
      <div className={`grid w-full max-w-5xl gap-6 ${gridCols}`}>
        <section className="surface-panel hidden overflow-hidden lg:block">
          <div className="flex h-full flex-col justify-between p-10">
            <div>
              <div className="inline-flex items-center gap-3 rounded-2xl bg-[rgba(255,255,255,0.78)] px-4 py-3 ring-1 ring-[var(--line-soft)]">
                <img src={browsermintIcon} alt="Browsermint" className="h-11 w-11 object-contain" />
                <div>
                  <div className="text-base font-semibold tracking-[-0.02em] text-[var(--text-strong)]">Browsermint</div>
                  <div className="text-sm text-[var(--text-soft)]">{t("layout.sidebarTagline")}</div>
                </div>
              </div>
              <div className="mt-12 max-w-xl">
                <div className="page-eyebrow">{eyebrow}</div>
                <h1 className="mt-4 text-[42px] font-semibold leading-[1.02] tracking-[-0.04em] text-[var(--text-strong)]">{title}</h1>
                <p className="mt-5 max-w-lg text-[15px] leading-7 text-[var(--text-soft)]">{subtitle}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="surface-panel flex items-center p-4 sm:p-6 lg:p-8">
          <div className="w-full rounded-[22px] bg-[rgba(248,250,253,0.92)] p-6 ring-1 ring-[var(--line-soft)] sm:p-8">
            <div className="mb-8 lg:hidden">
              <div className="flex items-center gap-3">
                <img src={browsermintIcon} alt="Browsermint" className="h-12 w-12 object-contain" />
                <div>
                  <div className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">Browsermint</div>
                  <div className="text-sm text-[var(--text-soft)]">{t("layout.sidebarTagline")}</div>
                </div>
              </div>
            </div>
            {children}
          </div>
        </section>
      </div>
    </div>
  );
}
