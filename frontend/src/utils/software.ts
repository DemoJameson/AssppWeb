import type { Platform, Software } from "../types";

/** A bare App ID record for the direct-download path: the storefront does not list it and
 * no local download recorded it, but the numeric id is usable. The version exchange resolves
 * its versions (iOS natively, other platforms once a version id is known); the record lives
 * until the exchange reports it is not an app (`isMissingAppError` in `apple/versionFinder`).
 * The placeholder name `App <id>` means "no name yet" to the backend — the two sides stay in sync.
 */
export function bareSoftwareById(id: string, platform: Platform): Software {
  return {
    id: Number(id),
    bundleID: "",
    name: `App ${id}`,
    version: "",
    artistName: "",
    sellerName: "",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "",
    releaseDate: "",
    primaryGenreName: "",
    platform,
    metadataSource: "bare",
  };
}

/**
 * True for a record the storefront did not supply (`local` or `bare`), whose
 * version list has to come from the version exchange — for a bare id, also the
 * only thing that can say whether an app exists behind it.
 */
export function needsVersionExchange(app: Software): boolean {
  return app.metadataSource === "local" || app.metadataSource === "bare";
}

/** True when the record holds no evidence for the platform being viewed, so the version
 * exchange is the only thing that can say whether anything is fetchable here (the flow
 * stays closed until it answers). A `local` record is evidence only for the platforms it
 * was recorded on: the backend fills `version` from the *requested* platform's build
 * (`buildForPlatform`), so an iOS-only record asked for as tvOS arrives empty and proves nothing.
 */
export function needsFetchVerification(app: Software): boolean {
  if (app.metadataSource === "bare") return true;
  return app.metadataSource === "local" && app.version === "";
}

/** The date part of a timestamp as `YYYY-MM-DD` in local time — one stable shape across
 * locales (`toLocaleDateString` would print `2026/9/17` or `9/17/2026`). Undefined when the
 * value is not a date, so callers keep their own "no data" fallback.
 */
export function formatDateISO(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * As {@link formatDateISO} with local time appended: `YYYY-MM-DD HH:mm:ss`, one
 * stable shape across locales (`toLocaleString` would vary by machine).
 */
export function formatDateTimeISO(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDateISO(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The price a record can honestly show, or undefined. Only a storefront result may fall
 * back to "free" (some storefronts omit `formattedPrice` for free apps); `local`/`bare`
 * records were never priced, so they render nothing rather than inventing a price.
 */
export function displayPrice(
  app: Software,
  freeLabel: string,
): string | undefined {
  if (app.formattedPrice) return app.formattedPrice;
  return needsVersionExchange(app) ? undefined : freeLabel;
}

/**
 * True for the "no name yet" placeholder `App <id>` — what a bare record is born
 * with and what the backend writes when a compiled package had no name. Icons
 * show the Apple mark instead of its first letter.
 */
export function isPlaceholderAppName(name: string): boolean {
  return /^App \d+$/.test(name);
}
