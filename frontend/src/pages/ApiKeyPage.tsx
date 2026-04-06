import { Key } from "lucide-react";
import { useI18n } from "../i18n/I18nContext.tsx";

export default function ApiKeyPage() {
  const { t } = useI18n();

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-gray-900 mb-8">{t("apiKey.title")}</h1>
      <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center py-20 gap-3">
        <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center">
          <Key size={20} className="text-gray-300" />
        </div>
        <p className="text-sm font-medium text-gray-500">{t("apiKey.comingSoon")}</p>
        <p className="text-xs text-gray-300">{t("apiKey.description")}</p>
      </div>
    </div>
  );
}
