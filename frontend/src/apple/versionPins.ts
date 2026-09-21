import { apiGet } from "../api/client";
import type { Platform } from "../types";

interface VersionPinsResponse {
  pins?: Array<{ platform?: string; versionId?: string }>;
}

/**
 * The version id recorded for an app+platform by previous downloads (the
 * backend's version-pin store), or undefined when none is known. Best effort
 * by design: any failure resolves to undefined so callers keep their live
 * Apple flow — the store never blocks a query.
 */
export async function recordedVersionIdFor(
  appId: string | number,
  platform?: Platform,
): Promise<string | undefined> {
  try {
    const res = await apiGet<VersionPinsResponse>(
      `/api/version-pins/${encodeURIComponent(String(appId))}`,
    );
    const wanted = platform ?? "ios";
    return res?.pins?.find((pin) => pin.platform === wanted)?.versionId ||
      undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version ids recorded for an app *outside* one platform — every pin whose
 * platform is not `platform`. A pin is a build this instance has already
 * downloaded, so an id it holds is a build of some other platform: a neighbour
 * guess must never offer it as this platform's pin. Best effort like the rest of
 * the store: a failure resolves to an empty list, which only means the guess
 * has one less thing it can rule out.
 */
export async function recordedVersionIdsExceptPlatform(
  appId: string | number,
  platform?: Platform,
): Promise<string[]> {
  try {
    const res = await apiGet<VersionPinsResponse>(
      `/api/version-pins/${encodeURIComponent(String(appId))}`,
    );
    const wanted = platform ?? "ios";
    return (res?.pins ?? [])
      .filter(
        (pin) =>
          pin.platform !== wanted &&
          typeof pin.versionId === "string" &&
          pin.versionId !== "",
      )
      .map((pin) => pin.versionId as string);
  } catch {
    return [];
  }
}

/**
 * Resolves a platform version id by running `lookup` (the live Apple
 * catalogue), falling back to the recorded pin when the lookup yields nothing
 * or fails — which is exactly the delisted-app case, where the catalogue has
 * no answer left. When neither source provides one, the result is undefined:
 * the lookup's failure is logged, never surfaced raw, so callers raise their
 * own clean "no version information" message instead of leaking a 404
 * storefront page or a parse hiccup into the UI.
 */
export async function withRecordedFallback(
  lookup: () => Promise<string | undefined>,
  appId: string | number,
  platform?: Platform,
): Promise<string | undefined> {
  let lookupError: unknown;
  try {
    const versionId = await lookup();
    if (versionId) return versionId;
  } catch (error) {
    lookupError = error;
  }

  const recorded = await recordedVersionIdFor(appId, platform);
  if (recorded) return recorded;

  if (lookupError) {
    console.warn(
      `[versions] lookup failed and no pin was recorded for app ${appId} (${platform ?? "ios"})`,
      lookupError,
    );
  }
  return undefined;
}
