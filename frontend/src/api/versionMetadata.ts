import { apiGet } from "./client";
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
