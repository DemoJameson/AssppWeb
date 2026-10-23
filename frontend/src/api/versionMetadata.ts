import { apiGet, apiPost, apiPut } from "./client";
import type { VersionMetadata } from "../types";

interface VersionMetadataResponse {
  entries?: Array<{
    versionId?: string;
    displayVersion?: string;
    releaseDate?: string;
    minimumOsVersion?: string;
    supportedPlatforms?: string[];
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
          ...(entry.minimumOsVersion !== undefined
            ? { minimumOsVersion: entry.minimumOsVersion }
            : {}),
          ...(Array.isArray(entry.supportedPlatforms) &&
          entry.supportedPlatforms.length > 0
            ? { supportedPlatforms: entry.supportedPlatforms }
            : {}),
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

interface VersionPlatformsResponse {
  platforms?: Record<string, string[]>;
}

/** Reads the declared platforms of every *attested package* version of an app —
 * the backend omits client- and URL-supplied entries, since only what this
 * instance compiled may clear another platform's recorded build. Best effort: a
 * missing answer just means no id gains extra evidence. */
export async function fetchVersionPlatforms(
  appId: string | number,
): Promise<Record<string, string[]>> {
  try {
    const res = await apiGet<VersionPlatformsResponse>(
      `/api/version-metadata/${encodeURIComponent(String(appId))}/platforms`,
    );
    const platforms: Record<string, string[]> = {};
    for (const [versionId, supported] of Object.entries(res?.platforms ?? {})) {
      if (
        /^\d+$/.test(versionId) &&
        Array.isArray(supported) &&
        supported.length > 0
      ) {
        platforms[versionId] = supported;
      }
    }
    return platforms;
  } catch {
    return {};
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
  bundleId?: string,
): Promise<VersionMetadata | undefined> {
  try {
    const res = await apiPost<{ entry?: VersionMetadata }>(
      `/api/version-metadata/${encodeURIComponent(String(appId))}/${encodeURIComponent(versionId)}/package`,
      { downloadURL, ...(bundleId ? { bundleId } : {}) },
    );
    if (!res?.entry?.displayVersion || !res.entry.releaseDate) return undefined;
    // Whatever the server kept: a `package-read` entry when it took the write, or
    // the pipeline's own `package` record when one already existed. Either way the
    // date is a build's, which is what `utils/versionLabels` prints a date for.
    return {
      displayVersion: res.entry.displayVersion,
      releaseDate: res.entry.releaseDate,
      ...(res.entry.minimumOsVersion !== undefined
        ? { minimumOsVersion: res.entry.minimumOsVersion }
        : {}),
      ...(Array.isArray(res.entry.supportedPlatforms) &&
      res.entry.supportedPlatforms.length > 0
        ? { supportedPlatforms: res.entry.supportedPlatforms }
        : {}),
      source: res.entry.source,
    };
  } catch {
    return undefined;
  }
}
