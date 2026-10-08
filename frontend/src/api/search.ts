import { apiGet } from "./client";
import { lookupEntityFor, searchEntityFor } from "../apple/platform";
import type { Platform, Software } from "../types";

export async function searchApps(
  term: string,
  country: string,
  platform: Platform = "ios",
  limit: number = 25,
): Promise<Software[]> {
  const params = new URLSearchParams({
    term,
    country,
    entity: searchEntityFor(platform),
    platform,
    limit: String(limit),
  });
  return apiGet<Software[]>(`/api/search?${params}`);
}

/**
 * Resolves an app from a bundle id. When the storefront no longer lists the app
 * (delisted), the backend answers from its package-app index instead of nothing.
 */
export async function lookupApp(
  bundleId: string,
  country: string,
  platform?: Platform,
): Promise<Software | null> {
  return lookup({ bundleId, country }, platform);
}

/**
 * Resolves an app from its numeric App Store id — same route as a bundle id, with
 * the package-app index as fallback. Returns null when nothing resolves it.
 */
export async function lookupAppById(
  id: string | number,
  country: string,
  platform?: Platform,
): Promise<Software | null> {
  return lookup({ id: String(id), country }, platform);
}

/**
 * Shared lookup request. The platform picks Apple's lookup entity (a bare id
 * search otherwise only ever sees iOS builds) and is echoed onto the result by the
 * backend, which strips it before forwarding to Apple.
 */
async function lookup(
  base: Record<string, string>,
  platform?: Platform,
): Promise<Software | null> {
  const params = new URLSearchParams(base);
  if (platform) {
    params.set("entity", lookupEntityFor(platform));
    params.set("platform", platform);
  }
  return apiGet<Software | null>(`/api/lookup?${params}`);
}
