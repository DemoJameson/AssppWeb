import type { DownloadTask } from "../types";

/**
 * Where a download's icon comes from.
 *
 * The storefront artwork wins, because it is how the store catalogues the app
 * and it is what the search results already show. A download created from a bare
 * app id never saw the storefront, so it falls back to the icon the backend
 * lifted out of the compiled package — and to nothing at all when the package
 * carried no usable image, which leaves the caller to draw its own placeholder.
 */
export function taskIconUrl(task: DownloadTask): string | undefined {
  if (task.software.artworkUrl) return task.software.artworkUrl;
  if (!task.hasIcon) return undefined;

  const params = new URLSearchParams({ accountHash: task.accountHash });
  return `/api/downloads/${task.id}/icon?${params}`;
}
