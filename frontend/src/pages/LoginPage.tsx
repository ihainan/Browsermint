import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "../components/AuthShell.tsx";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";

export default function LoginPage() {
  const { login, user, registrationEnabled } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });

  const emailError = touched.email && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? t("common.invalidEmail") : "";
  const canSubmit = !isPending && email.length > 0 && password.length > 0 && !emailError;

  if (user) {
    navigate("/", { replace: true });
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setIsPending(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        t("login.loginFailed");
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AuthShell
      title={t("login.heroTitle")}
      subtitle={t("login.heroDescription")}
      eyebrow={t("login.subtitle")}
    >
      <h2 className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-[var(--text-strong)]">{t("login.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--text-soft)]">{t("login.subtitle")}</p>

      {error && (
        <div className="mt-6 rounded-2xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger-main)] ring-1 ring-[rgba(194,74,67,0.16)]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-7 space-y-4">
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{t("common.email")}</label>
          <input
            type="email" required value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setTouched((prev) => ({ ...prev, email: true }))}
            className={`control-input${emailError ? " border-[var(--danger-main)] ring-[var(--danger-main)]" : ""}`}
            placeholder="you@example.com"
          />
          {emailError && <p className="mt-1 text-xs text-[var(--danger-main)]">{emailError}</p>}
        </div>
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{t("common.password")}</label>
          <input
            type="password" required value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setTouched((prev) => ({ ...prev, password: true }))}
            className="control-input"
            placeholder="••••••••"
          />
        </div>
        <button type="submit" disabled={!canSubmit} className="button-primary mt-2 w-full">{isPending ? t("login.submitting") : t("login.submit")}</button>
      </form>

      {registrationEnabled && (
        <p className="mt-6 text-sm text-[var(--text-soft)]">
          {t("login.noAccount")}{" "}
          <Link className="font-medium text-[var(--text-strong)] underline-offset-4 hover:underline" to="/register">
            {t("login.createOne")}
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
