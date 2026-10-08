import { isActiveDownload, useDownloadsStore } from "../store/downloads";

/**
 * Downloads currently in progress (queued, transferring or compiling), for the
 * Downloads tab badge. The store polls while anything is active.
 */
export function useActiveDownloadCount(): number {
  return useDownloadsStore((s) => s.tasks.filter(isActiveDownload).length);
}
