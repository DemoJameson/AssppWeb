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
 * whole message — it is the actionable part of the screen — and offers a
 * retry, since the toast that announced it is already gone.
 */
export default function SapStatus({ onRetry }: { onRetry?: () => void }) {
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
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-red-600 dark:text-red-400"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t("accounts.addForm.signerFailed", { error: error ?? "" })}
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-full bg-red-50 px-2.5 py-0.5 font-semibold text-red-700 transition-colors hover:bg-red-100 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-950"
            >
              {t("accounts.addForm.signerRetry")}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
