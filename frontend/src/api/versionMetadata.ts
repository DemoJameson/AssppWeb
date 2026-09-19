import { apiGet, apiPost, apiPut } from "./client";
import type { VersionMetadata } from "../types";

interface VersionMetadataResponse {
  entries?: Array<{
    versionId?: string;
    displayVersion?: string;
    releaseDate?: string;
    source?: "package" | "client";
  }>;
}

/**
 * Reads the backend's shared version metadata cache for an app, keyed by
 * version id. Best effort by design: any failure resolves to an empty map so
 * callers degrade to the live Apple flow — the cache never blocks a picker.
 */
export async function fetchVersionMetadata(
  appId: string | number,
): Promise<Record<string, VersionMetadata>> {
  try {
    const res = await apiGet<VersionMetadataResponse>(
      `/api/version-metadata/${encodeURIComponent(String(appId))}`,
    );

    const map: Record<string, VersionMetadata> = {};
    for (const entry of res?.entries ?? []) {
      if (entry?.versionId && entry.displayVersion && entry.releaseDate) {
        map[entry.versionId] = {
          displayVersion: entry.displayVersion,
          releaseDate: entry.releaseDate,
          source: entry.source,
        };
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Saves metadata the frontend fetched live from Apple into the backend's
 * shared cache. Best effort: failures resolve silently because the live value
 * is already on screen — the server may also decline (saved: false) when a
 * compiled package already knows better. The request is keepalive, so a
 * lookup that lands just as the user closes the page still gets delivered.
 */
export async function saveVersionMetadata(
  appId: string | number,
  versionId: string,
  metadata: VersionMetadata,
): Promise<void> {
  try {
    await apiPut(
      `/api/version-metadata/${encodeURIComponent(String(appId))}/${encodeURIComponent(versionId)}`,
      metadata,
      { keepalive: true },
    );
  } catch {
    // Silent — the entry stays local for this session.
  }
}

/**
 * Asks the backend to read a version's metadata out of its own package — the
 * per-build source of truth for the release date, which the exchange's
 * app-level value is not (see `services/packageVersionMetadata`). Best effort:
 * a failure resolves to `undefined` and the caller keeps whatever the exchange
 * said, minus the date it cannot vouch for.
 */
export async function fetchPackageVersionMetadata(
  appId: string | number,
  versionId: string,
  downloadURL: string,
): Promise<VersionMetadata | undefined> {
  try {
    const res = await apiPost<{ entry?: VersionMetadata }>(
      `/api/version-metadata/${encodeURIComponent(String(appId))}/${encodeURIComponent(versionId)}/package`,
      { downloadURL },
    );
    if (!res?.entry?.displayVersion || !res.entry.releaseDate) return undefined;
    // Read from the package, so the date is the build's own.
    return { ...res.entry, source: "package" };
  } catch {
    return undefined;
  }
}
