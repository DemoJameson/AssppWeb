import type { VersionMetadata } from "../types";

/**
 * Option text for the download version pickers (AddDownload, DownloadById):
 * the display version leads, followed by its release date; the external id
 * stays in parentheses because it is the value the picker submits.
 */
export function versionOptionLabel(
  versionId: string,
  meta?: VersionMetadata,
): string {
  if (!meta) return versionId;
  const date = meta.releaseDate.slice(0, 10);
  return `v${meta.displayVersion} · ${date} (${versionId})`;
}

/**
 * Row text for version browsing (VersionHistory, PackageDetail): the display
 * version leads, with the external id in parentheses when cached; uncached
 * rows show the raw id.
 */
export function versionRowLabel(
  versionId: string,
  meta?: VersionMetadata,
): string {
  return meta ? `v${meta.displayVersion} (${versionId})` : versionId;
}
