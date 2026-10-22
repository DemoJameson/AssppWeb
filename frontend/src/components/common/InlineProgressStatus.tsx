import { useTranslation } from "react-i18next";
import Spinner from "./Spinner";
import type { DownloadProgressStage } from "../../apple/sap/client";

interface InlineProgressStatusProps {
  stage: DownloadProgressStage | null;
}

/**
 * A quiet, one-line status for a user-initiated download-product exchange. The
 * stage is implementation-free so the user never has to know what kbsync is.
 */
export default function InlineProgressStatus({
  stage,
}: InlineProgressStatusProps) {
  const { t } = useTranslation();

  return (
    <div className="min-h-4 text-xs" aria-live="polite">
      {stage && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400"
        >
          <Spinner />
          <span className="min-w-0 truncate">
            {t(`downloads.progress.${stage}`)}
          </span>
        </p>
      )}
    </div>
  );
}
