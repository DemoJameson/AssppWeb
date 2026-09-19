import i18n from "../i18n";
import type { VersionMetadata } from "../types";

/**
 * The date a version row may print: only one that was read out of the build's
 * own package. Apple's exchange metadata dates the *app* — the same day comes
 * back whichever version is pinned, and the `iTunesMetadata.plist` inside a
 * download says the same thing — so a package read (the backend's
 * `packageVersionMetadata`, ipatool's way) is the only source a date can come
 * from without being wrong for every other row.
 */
function datedLabel(versionId: string, meta: VersionMetadata): string {
  if (meta.source === "package" && meta.releaseDate) {
    return `${meta.displayVersion} (${versionId}) · ${meta.releaseDate.slice(0, 10)}`;
  }
  return `${meta.displayVersion} (${versionId})`;
}

/**
 * Option text for the download version pickers (ProductDetail, PackageDetail):
 * the display version leads, the external id stays in parentheses because it is
 * the value the picker submits, and the release date follows when a package
 * vouches for it. A version still being looked up shows a fetching marker
 * instead of a bare id.
 */
export function versionOptionLabel(
  versionId: string,
  meta?: VersionMetadata,
  pending = false,
): string {
  if (!meta) {
    return pending
      ? `${versionId} · ${i18n.t("search.versions.fetching")}`
      : versionId;
  }
  return datedLabel(versionId, meta);
}

/**
 * Row text for version browsing (PackageDetail's update picker, VersionHistory):
 * the same shape as {@link versionOptionLabel}, so the app's two version menus
 * read alike. Uncached rows show the raw id, with a fetching marker while their
 * lookup runs.
 */
export function versionRowLabel(
  versionId: string,
  meta?: VersionMetadata,
  pending = false,
): string {
  if (meta) return datedLabel(versionId, meta);
  return pending
    ? `${versionId} · ${i18n.t("search.versions.fetching")}`
    : versionId;
}
