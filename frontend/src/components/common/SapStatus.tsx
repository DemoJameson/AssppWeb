import { useTranslation } from "react-i18next";
import { useSapStore } from "../../store/sap";

/**
 * What the SAP signer is doing, for the form waiting on it. The slot keeps one
 * line's height so messages never shift the buttons; assets-download explains
 * the unseen first-run cost, and a failure keeps its full, actionable message.
 */
export default function SapStatus() {
  const { t } = useTranslation();
  const stage = useSapStore((state) => state.stage);
  const error = useSapStore((state) => state.error);

  return (
    <div className="min-h-4 text-xs">
      {stage === "assets" && (
        <p
          role="status"
          aria-live="polite"
          className="text-gray-500 dark:text-gray-400"
        >
          {t("accounts.addForm.signerFirstRun")}
        </p>
      )}
      {stage === "error" && (
        <p
          role="alert"
          className="text-red-600 [overflow-wrap:anywhere] dark:text-red-400"
        >
          {t("accounts.addForm.signerFailed", { error: error ?? "" })}
        </p>
      )}
    </div>
  );
}
