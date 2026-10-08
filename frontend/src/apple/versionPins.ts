import { apiGet } from "../api/client";
import type { Platform } from "../types";

interface VersionPinsResponse {
  pins?: Array<{ platform?: string; versionId?: string }>;
}

/** The version id recorded for an app+platform by previous downloads (the backend's
 * version-pin store), or undefined when none is known. Best effort: any failure
 * resolves to undefined so the store never blocks a live Apple flow.
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

/** The version ids recorded for an app *outside* one platform. A pin is a build already
 * downloaded here, so an id it holds is another platform's build a neighbour guess must
 * never offer as this platform's pin. Best effort: a failure resolves to an empty list.
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

/** Resolves a platform version id by running `lookup` (the live Apple catalogue),
 * falling back to the recorded pin when it yields nothing or fails — the delisted-app
 * case. When neither source answers, the result is undefined and the lookup's failure is
 * only logged, so callers raise their own clean "no version information" message rather
 * than leaking a storefront 404 or parse hiccup into the UI.
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
