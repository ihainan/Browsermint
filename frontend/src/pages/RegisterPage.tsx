import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "../components/AuthShell.tsx";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";

export default function RegisterPage() {
  const { register, user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [touched, setTouched] = useState({ username: false, email: false, password: false });

  const usernameError = touched.username && username && !/^[a-zA-Z0-9_]{3,64}$/.test(username)
    ? t("common.invalidUsername") : "";
  const emailError = touched.email && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? t("common.invalidEmail") : "";
  const passwordError = touched.password && password && password.length < 12
    ? t("register.passwordTooShort") : "";
  const canSubmit = !isPending && username.length >= 3 && email.length > 0 && password.length >= 12
    && !usernameError && !emailError && !passwordError;

  if (user) {
    navigate("/sessions", { replace: true });
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setTouched({ username: true, email: true, password: true });
    if (!canSubmit) return;
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
    <AuthShell
      title={t("register.heroTitle")}
      subtitle={t("register.heroDescription")}
      eyebrow={t("register.subtitle")}
      gridCols="lg:grid-cols-[1.1fr_0.9fr]"
    >
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
          <input
            type="text" required value={username}
            onChange={(event) => setUsername(event.target.value)}
            onBlur={() => setTouched((prev) => ({ ...prev, username: true }))}
            pattern="[a-zA-Z0-9_]+" minLength={3} maxLength={64}
            className={`control-input${usernameError ? " border-[var(--danger-main)] ring-[var(--danger-main)]" : ""}`}
            placeholder="your_username"
          />
          {usernameError && <p className="mt-1 text-xs text-[var(--danger-main)]">{usernameError}</p>}
        </div>
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
            minLength={12}
            className={`control-input${passwordError ? " border-[var(--danger-main)] ring-[var(--danger-main)]" : ""}`}
            placeholder={t("register.passwordHint")}
          />
          {passwordError && <p className="mt-1 text-xs text-[var(--danger-main)]">{passwordError}</p>}
        </div>
        <button type="submit" disabled={!canSubmit} className="button-primary mt-2 w-full">{isPending ? t("register.submitting") : t("register.submit")}</button>
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
