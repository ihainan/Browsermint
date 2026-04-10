import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";

function LoadingSpinner() {
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface-panel flex items-center gap-3 px-6 py-4 text-sm text-[var(--text-soft)]">
        <Loader2 size={18} className="animate-spin text-[var(--brand-strong)]" />
        <span>{t("common.loadingWorkspace")}</span>
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
