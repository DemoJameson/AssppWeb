import { apiGet } from "./client";
import type { Software } from "../types";

export async function searchApps(
  term: string,
  country: string,
  entity: string,
  limit: number = 25,
): Promise<Software[]> {
  const params = new URLSearchParams({
    term,
    country,
    entity: entity === "iPad" ? "iPadSoftware" : "software",
    limit: String(limit),
  });
  return apiGet<Software[]>(`/api/search?${params}`);
}

export async function lookupApp(
  bundleId: string,
  country: string,
): Promise<Software | null> {
  const params = new URLSearchParams({ bundleId, country });
  return apiGet<Software | null>(`/api/lookup?${params}`);
}

/**
 * Resolves an app from its numeric App Store id. The backend forwards the query
 * to Apple's lookup endpoint verbatim, so `id` works the same way `bundleId`
 * does. Returns null when the id is unknown to that storefront.
 */
export async function lookupAppById(
  id: string | number,
  country: string,
): Promise<Software | null> {
  const params = new URLSearchParams({ id: String(id), country });
  return apiGet<Software | null>(`/api/lookup?${params}`);
}
