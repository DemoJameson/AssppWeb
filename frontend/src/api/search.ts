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

export async function lookupApp(
  bundleId: string,
  country: string,
  platform?: Platform,
): Promise<Software | null> {
  return lookup({ bundleId, country }, platform);
}

/**
 * Resolves an app from its numeric App Store id. The backend forwards the query
 * to Apple's lookup endpoint verbatim, so `id` works the same way `bundleId`
 * does. Returns null when the id is unknown to that storefront.
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
 * search would otherwise only ever see iOS builds) and is echoed onto the
 * result by the backend, which strips it before forwarding to Apple.
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
