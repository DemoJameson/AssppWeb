import type { VersionMetadata } from "../types";

/**
 * Whether an entry's date came out of a build's own package.
 *
 * This is the one question every gate on `VersionMetadata.source` is really
 * asking, which is why it lives here rather than being spelled out again at each
 * site — four of them do: the labels print a date only for this kind
 * (`versionLabels`), the detail table shows one only for this kind, the session
 * store lets this kind displace a value already on screen
 * (`store/versionMetadata`), and the silent fill treats this kind as done
 * (`useVersionMetadata`).
 *
 * Two sources qualify: `package` — the instance's own compile, the only read the
 * server can attest — and `package-read`, the same read performed at a URL a
 * client handed over. The bytes came out of a package either way, so the date is
 * the build's; what `package` alone also carries is authority, which is the
 * backend's business and not this one.
 *
 * `client` never qualifies: Apple's exchange dates the *app*, so the same day
 * comes back for every version of a list and printing it would present one
 * build's release day as another's.
 */
export function dateComesFromPackage(
  source?: VersionMetadata["source"],
): boolean {
  return source === "package" || source === "package-read";
}