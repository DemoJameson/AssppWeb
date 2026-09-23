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
 * Option text for the download version pickers (ProductDetail's, and the
 * downloads page's update picker):
 * the display version leads, the external id stays in parentheses because it is
 * the value the picker submits, and the release date follows when a package
 * vouches for it. A version being looked up right now appends a fetching
 * marker, date or not — the row is still waiting on its lookup.
 */
export function versionOptionLabel(
  versionId: string,
  meta?: VersionMetadata,
  pending = false,
): string {
  const label = meta ? datedLabel(versionId, meta) : versionId;
  return pending ? `${label} · ${i18n.t("search.versions.fetching")}` : label;
}

/**
 * Row text for version browsing (the downloads page's update picker):
 * the same shape as {@link versionOptionLabel}, so the version menus
 * read alike. Uncached rows show the raw id; a lookup in flight appends the
 * fetching marker.
 */
export function versionRowLabel(
  versionId: string,
  meta?: VersionMetadata,
  pending = false,
): string {
  const label = meta ? datedLabel(versionId, meta) : versionId;
  return pending ? `${label} · ${i18n.t("search.versions.fetching")}` : label;
}
