import { useTranslation } from "react-i18next";
import { useSapStore } from "../../store/sap";

/**
 * What the SAP signer is doing, for the form that waits on it. It sits in the
 * submit area — where the eye already is when the button goes busy — and the
 * slot keeps a single line's height at all times, so a message appearing or
 * clearing never moves the buttons above it.
 *
 * Idle and ready say nothing. While the assets download it explains the one
 * thing that costs time and cannot be seen (the first run fetches them); the
 * percentage itself rides on the submit button's label. A failure keeps its
 * whole message — it is the actionable part of the screen; the retry lives on
 * the submit button itself, which relabels to offer it.
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
