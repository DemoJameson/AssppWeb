import type { Platform, Software } from "../types";

/**
 * A bare App ID record for the direct-download path: nothing knows the app yet —
 * the storefront does not list it and no local download recorded it — but the
 * numeric id is still usable. The version exchange resolves its versions (iOS
 * natively, other platforms once a version id is known) and the download
 * proceeds from there, so the record is kept until that exchange reports the id
 * is not an app at all (`isMissingAppError` in `apple/versionFinder`).
 *
 * The placeholder name `App <id>` is the label the backend reads as "no name
 * yet" when a compiled package supplies the real one; the two sides are written
 * together and must stay in sync.
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
 * True for a record the storefront did not supply — `local` (recalled from the
 * package index) or `bare` (a numeric App ID nothing knows). Their version list
 * has to come from the version exchange, which for a bare id is also the only
 * thing that can say whether there is an app behind it at all.
 */
export function needsVersionExchange(app: Software): boolean {
  return app.metadataSource === "local" || app.metadataSource === "bare";
}

/**
 * True when the record holds no evidence for the platform being viewed, so the
 * version exchange is the only thing that can say whether anything is
 * fetchable here — and the flow stays closed until it answers.
 *
 * A `local` record is evidence for the platforms it was recorded on, and only
 * those: the backend fills `version` from the *requested* platform's recorded
 * build (`buildForPlatform`) and leaves it empty when that platform was never
 * downloaded. An iOS-only record asked for as tvOS therefore arrives with an
 * empty version and proves nothing about tvOS — the same open question a bare
 * App ID poses, and Apple's exchange is what settles it.
 */
export function needsFetchVerification(app: Software): boolean {
  if (app.metadataSource === "bare") return true;
  return app.metadataSource === "local" && app.version === "";
}

/**
 * The date part of a timestamp as `YYYY-MM-DD`, in the viewer's local time —
 * one stable shape across locales (`toLocaleDateString` would print `2026/9/17`
 * or `9/17/2026` depending on the machine). Undefined when the value is not a
 * date, so callers keep their own "no data" fallback.
 */
export function formatDateISO(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Same as {@link formatDateISO} with the local time appended: `YYYY-MM-DD
 * HH:mm:ss`, one stable shape across locales (`toLocaleString` would print
 * `2026/9/19 04:16:57` or `9/19/2026, 4:16:57 AM` depending on the machine).
 */
export function formatDateTimeISO(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDateISO(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The price a record can honestly show, or `undefined` when it has none to
 * show. Only a storefront result may fall back to "free": some storefronts
 * omit `formattedPrice` for free apps, so its absence there still means "no
 * charge". A `local` (delisted, recalled from the package index) or `bare`
 * record was never priced by anyone in this session — a fallback would invent
 * a price and a placeholder dash would dress the emptiness up as data, so both
 * render nothing at all.
 */
export function displayPrice(
  app: Software,
  freeLabel: string,
): string | undefined {
  if (app.formattedPrice) return app.formattedPrice;
  return needsVersionExchange(app) ? undefined : freeLabel;
}

/**
 * True for the "no name yet" placeholder `App <id>` — what a bare record is
 * born with and what the backend writes when a compiled package had no name.
 * Its first letter is the "A" of "App", which says nothing about the app, so
 * icons show the Apple mark instead.
 */
export function isPlaceholderAppName(name: string): boolean {
  return /^App \d+$/.test(name);
}
