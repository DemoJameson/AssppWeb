import type { VersionMetadata } from "../types";

/**
 * Whether an entry's date came out of a build's own package — the one question
 * every gate on `VersionMetadata.source` asks (labels, detail table, session
 * store, silent fill). `package` and `package-read` qualify (both are package
 * reads); `client` does not: Apple's exchange dates the *app*, so the same day
 * comes back for every version of a list.
 */
export function dateComesFromPackage(
  source?: VersionMetadata["source"],
): boolean {
  return source === "package" || source === "package-read";
}