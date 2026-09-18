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
 * Resolves a platform version id by running `lookup` (the live Apple
 * catalogue), falling back to the recorded pin when the lookup yields nothing
 * or fails — which is exactly the delisted-app case, where the catalogue has
 * no answer left. When neither source provides one, the lookup's own failure
 * (if any) is rethrown so callers keep their previous error behaviour.
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

  if (lookupError) throw lookupError;
  return undefined;
}
