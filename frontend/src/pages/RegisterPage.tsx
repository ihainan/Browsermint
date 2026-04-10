import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import browsermintIcon from "../assets/browsermint-icon.png";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";

function AuthShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1.1fr_0.9fr]">
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
                <div className="page-eyebrow">Browser workspace</div>
                <h1 className="mt-4 text-[42px] font-semibold leading-[1.02] tracking-[-0.04em] text-[var(--text-strong)]">{title}</h1>
                <p className="mt-5 max-w-lg text-[15px] leading-7 text-[var(--text-soft)]">{subtitle}</p>
              </div>
            </div>
            <div className="surface-card px-5 py-5">
              <div className="subtle-label">Browsermint</div>
              <p className="mt-3 max-w-xl text-sm leading-7 text-[var(--text-soft)]">{t("register.heroDescription")}</p>
            </div>
          </div>
        </section>

        <section className="surface-panel flex items-center p-4 sm:p-6 lg:p-8">
          <div className="w-full rounded-[22px] bg-[rgba(255,253,249,0.92)] p-6 ring-1 ring-[var(--line-soft)] sm:p-8">
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

export default function RegisterPage() {
  const { register, user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  if (user) {
    navigate("/sessions", { replace: true });
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (password.length < 12) {
      setError(t("register.passwordTooShort"));
      return;
    }

    setIsPending(true);
    try {
      await register(username, email, password);
      navigate("/sessions", { replace: true });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        t("register.registrationFailed");
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AuthShell title={t("register.heroTitle")} subtitle={t("register.heroDescription")}>
      <div className="page-eyebrow">{t("register.title")}</div>
      <h2 className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-[var(--text-strong)]">{t("register.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--text-soft)]">{t("register.subtitle")}</p>

      {error && (
        <div className="mt-6 rounded-2xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger-main)] ring-1 ring-[rgba(194,74,67,0.16)]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-7 space-y-4">
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{t("common.username")}</label>
          <input type="text" required value={username} onChange={(event) => setUsername(event.target.value)} pattern="[a-zA-Z0-9_]+" minLength={3} maxLength={64} className="control-input" placeholder="your_username" />
        </div>
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{t("common.email")}</label>
          <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="control-input" placeholder="you@example.com" />
        </div>
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{t("common.password")}</label>
          <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} className="control-input" placeholder={t("register.passwordHint")} />
        </div>
        <button type="submit" disabled={isPending} className="button-primary mt-2 w-full">{isPending ? t("register.submitting") : t("register.submit")}</button>
      </form>

      <p className="mt-6 text-sm text-[var(--text-soft)]">
        {t("register.hasAccount")}{" "}
        <Link className="font-medium text-[var(--text-strong)] underline-offset-4 hover:underline" to="/login">
          {t("register.signIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
