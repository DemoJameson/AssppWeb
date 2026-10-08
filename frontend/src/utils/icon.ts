import type { DownloadTask } from "../types";

/**
 * Where a download's icon comes from. The storefront artwork wins — it is how
 * the store catalogues the app and what search results already show. A download
 * from a bare app id never saw the storefront, so it falls back to the icon the
 * backend lifted from the compiled package, or nothing at all (the caller draws
 * its own placeholder).
 */
export function taskIconUrl(task: DownloadTask): string | undefined {
  if (task.software.artworkUrl) return task.software.artworkUrl;
  if (!task.hasIcon) return undefined;

  const params = new URLSearchParams({ accountHash: task.accountHash });
  return `/api/downloads/${task.id}/icon?${params}`;
}
