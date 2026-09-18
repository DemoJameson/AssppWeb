import { apiGet, apiPut } from "./client";
import type { VersionMetadata } from "../types";

interface VersionMetadataResponse {
  entries?: Array<{
    versionId?: string;
    displayVersion?: string;
    releaseDate?: string;
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
 * compiled package already knows better.
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
    );
  } catch {
    // Silent — the entry stays local for this session.
  }
}
