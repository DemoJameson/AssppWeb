import type { VersionMetadata } from "../types";

/**
 * Option text for the download version pickers (AddDownload, DownloadById):
 * the external id stays first because it is the value the picker submits; a
 * cached display version is appended in parentheses.
 */
export function versionOptionLabel(
  versionId: string,
  meta?: VersionMetadata,
): string {
  return meta ? `${versionId} (v${meta.displayVersion})` : versionId;
}

/**
 * Row text for version browsing (VersionHistory, PackageDetail): the display
 * version leads, with the external id in parentheses when cached; uncached
 * rows keep the historical `ID:` placeholder.
 */
export function versionRowLabel(
  versionId: string,
  meta?: VersionMetadata,
): string {
  return meta ? `v${meta.displayVersion} (${versionId})` : `ID: ${versionId}`;
}
