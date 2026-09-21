import { apiGet } from "./client";

interface PackageBuildsResponse {
  builds?: Array<{
    platform?: string;
    versionId?: string;
    version?: string;
  }>;
}

/**
 * Every build the package-app index holds of an app, one entry per platform
 * (the platform a compiled package belongs to, with the external version id it
 * carried).
 *
 * It answers what the pin store cannot: a pin holds the newest id per platform,
 * while the index holds every build ever compiled on this instance — so a caller
 * that has to rule *another platform's build* out (the neighbour-id guess) sees
 * all of them, not just the latest.
 *
 * Best effort like the other backend stores: a failure resolves to an empty
 * list, which only means the caller has one less id it can rule out.
 */
export async function fetchPackageBuilds(
  appId: string | number,
): Promise<Array<{ platform?: string; versionId?: string }>> {
  try {
    const res = await apiGet<PackageBuildsResponse>(
      `/api/package-builds/${encodeURIComponent(String(appId))}`,
    );
    return res?.builds ?? [];
  } catch {
    return [];
  }
}
