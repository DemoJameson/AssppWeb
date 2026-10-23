import { useTranslation } from "react-i18next";
import type { DownloadExchangeProgress } from "../../apple/sap/client";

interface InlineProgressStatusProps {
  progress: DownloadExchangeProgress | null;
}

/**
 * A quiet, one-line status for a user-initiated download-product exchange. The
 * stage is implementation-free so the user never has to know what kbsync is.
 */
export default function InlineProgressStatus({
  progress,
}: InlineProgressStatusProps) {
  const { t } = useTranslation();
  const percent = progress?.percent;
  const hasPercent =
    progress?.stage === "preparing" &&
    percent !== null &&
    percent !== undefined;
  const label = progress
    ? hasPercent
      ? t("downloads.progress.preparingLabel")
      : t(`downloads.progress.${progress.stage}`)
    : null;

  return (
    <div className="min-h-4 text-xs">
      {progress && (
        <>
          {/* Only stage changes enter the live region; byte-by-byte progress does not. */}
          <span role="status" aria-live="polite" className="sr-only">
            {t(`downloads.progress.${progress.stage}`)}
          </span>
          <p
            aria-hidden="true"
            className="flex min-w-0 items-center gap-1.5 text-gray-500 tabular-nums dark:text-gray-400"
          >
            <span className="min-w-0 truncate">{label}</span>
            {hasPercent && (
              <span className="shrink-0 tabular-nums"> {percent}%</span>
            )}
          </p>
          {hasPercent && (
            <span
              role="progressbar"
              aria-label={t("downloads.progress.preparing")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="sr-only"
            />
          )}
        </>
      )}
    </div>
  );
}
