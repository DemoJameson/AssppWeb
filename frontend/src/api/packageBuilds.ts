import { apiGet } from "./client";

interface PackageBuildsResponse {
  builds?: Array<{
    platform?: string;
    versionId?: string;
    version?: string;
  }>;
}

/**
 * Every build the package-app index holds of an app, one entry per platform with
 * the external version id it carried. Unlike the pin store (newest id per
 * platform), it holds every build ever compiled, so a caller ruling another
 * platform's build out sees all of them. Best effort: failure resolves to [].
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
