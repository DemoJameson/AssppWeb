import { isActiveDownload, useDownloadsStore } from "../store/downloads";

/**
 * The number of downloads in progress right now (queued, transferring or
 * compiling), for the Downloads tab badge. The store polls the task list while
 * anything is active, so the count keeps itself current.
 */
export function useActiveDownloadCount(): number {
  return useDownloadsStore((s) => s.tasks.filter(isActiveDownload).length);
}
