import { apiGet, apiPost, apiPut } from "./client";
import type { VersionMetadata } from "../types";

interface VersionMetadataResponse {
  entries?: Array<{
    versionId?: string;
    displayVersion?: string;
    releaseDate?: string;
    source?: "package" | "package-read" | "client";
  }>;
}

/**
 * Reads the backend's shared version metadata cache for an app, keyed by version
 * id. Best effort: failure resolves to an empty map, so callers degrade to the
 * live Apple flow — the cache never blocks a picker.
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
 * Saves metadata the frontend fetched live from Apple into the backend's shared
 * cache. Best effort: failures resolve silently (the live value is already on
 * screen), and the server may decline when a compiled package knows better. The
 * request is keepalive, so a lookup landing as the page closes still gets delivered.
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
 * per-build source of truth for the release date, which the exchange's app-level
 * value is not (see `services/packageVersionMetadata`). Best effort: failure
 * resolves to `undefined`.
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
    // Whatever the server kept: a `package-read` entry when it took the write, or
    // the pipeline's own `package` record when one already existed. Either way the
    // date is a build's, which is what `utils/versionLabels` prints a date for.
    return {
      displayVersion: res.entry.displayVersion,
      releaseDate: res.entry.releaseDate,
      source: res.entry.source,
    };
  } catch {
    return undefined;
  }
}
