import { Router, Request, Response } from "express";
import { ITUNES_TIMEOUT_MS } from "../config.js";
import type { Platform } from "../types/index.js";
import {
  buildForPlatform,
  findPackageAppByAppId,
  findPackageAppByBundleId,
  searchPackageAppsByName,
} from "../services/packageAppStore.js";
import type { PackageAppRecord } from "../services/packageAppStore.js";

const router = Router();

/**
 * Accepted `platform` values: the frontend's `Platform` plus ipatool's aliases.
 * Unknown values are dropped, never forwarded to Apple.
 */
const PLATFORM_VALUES: Record<string, Platform> = {
  ios: "ios",
  iphone: "ios",
  ipad: "ipad",
  tvos: "tvos",
  appletv: "tvos",
  visionos: "visionos",
  macos: "macos",
};

function parsePlatform(value: unknown): Platform | undefined {
  if (typeof value !== "string") return undefined;
  return PLATFORM_VALUES[value.toLowerCase()];
}

// Map iTunes API fields to our Software type, matching Swift CodingKeys
function mapSoftware(item: Record<string, any>, platform?: Platform) {
  return {
    id: item.trackId,
    bundleID: item.bundleId,
    name: item.trackName,
    version: item.version,
    price: item.price,
    artistName: item.artistName,
    sellerName: item.sellerName,
    description: item.description,
    averageUserRating: item.averageUserRating,
    userRatingCount: item.userRatingCount,
    artworkUrl: item.artworkUrl512 ?? item.artworkUrl100,
    screenshotUrls: item.screenshotUrls ?? [],
    minimumOsVersion: item.minimumOsVersion,
    fileSizeBytes: item.fileSizeBytes,
    releaseDate: item.currentVersionReleaseDate ?? item.releaseDate,
    releaseNotes: item.releaseNotes,
    formattedPrice: item.formattedPrice,
    primaryGenreName: item.primaryGenreName,
    // The caller's platform choice is authoritative, not the entity's.
    platform,
  };
}

router.get("/search", async (req: Request, res: Response) => {
  try {
    const platform = parsePlatform(req.query.platform);
    const query = { ...req.query } as Record<string, string>;
    delete query.platform;
    const params = new URLSearchParams(query);
    const response = await fetch(
      `https://itunes.apple.com/search?${params.toString()}`,
      { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) },
    );
    const data = await response.json();
    const results = (data.results ?? []).map((item: Record<string, any>) =>
      mapSoftware(item, platform),
    );
    // Merge delisted apps' name matches from the package-app index on top (a
    // name match only proves the app was downloaded once, not that it is
    // delisted). Re-check each by bundle id: if the storefront still has it, use
    // that data untagged; only otherwise tag it as a local record.
    const term = typeof req.query.term === "string" ? req.query.term : "";
    if (term.trim()) {
      const seen = new Set(results.map((item: any) => item.id));
      const country =
        typeof req.query.country === "string" ? req.query.country : "us";
      const localMatches = searchPackageAppsByName(term)
        .filter((record) => !seen.has(Number(record.appId)))
        .slice(0, 10);

      const rechecked = await Promise.all(
        localMatches.map(async (record) => {
          try {
            const lookupResponse = await fetch(
              `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(record.bundleID)}&country=${encodeURIComponent(country)}`,
              { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) },
            );
            const lookupData = await lookupResponse.json();
            if (lookupData.resultCount > 0 && lookupData.results?.length > 0) {
              const storefrontApp = mapSoftware(
                lookupData.results[0],
                platform,
              );
              if (seen.has(storefrontApp.id)) return null;
              seen.add(storefrontApp.id);
              return storefrontApp;
            }
          } catch {
            // Lookup failed — fall through to the local record.
          }
          return softwareFromRecord(record, platform);
        }),
      );

      for (const item of rechecked) {
        if (item) results.unshift(item);
      }
    }
    res.json(results);
  } catch (err) {
    console.error("Search error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Search request failed" });
  }
});

router.get("/lookup", async (req: Request, res: Response) => {
  try {
    const platform = parsePlatform(req.query.platform);
    const query = { ...req.query } as Record<string, string>;
    delete query.platform;
    const params = new URLSearchParams(query);
    const response = await fetch(
      `https://itunes.apple.com/lookup?${params.toString()}`,
      { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) },
    );
    const data = await response.json();
    if (!data.resultCount || !data.results?.length) {
      // Storefront forgot the app — fall back to the package-app index so
      // delisted apps stay findable.
      res.json(localSoftwareFrom(req.query, platform) ?? null);
      return;
    }
    res.json(mapSoftware(data.results[0], platform));
  } catch (err) {
    console.error("Lookup error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Lookup request failed" });
  }
});

export default router;

/**
 * Builds a Software record from the package-app index when the storefront knows
 * nothing about the app. `metadataSource` marks it as local for the frontend.
 */
function localSoftwareFrom(query: Record<string, unknown>, platform?: Platform) {
  const bundleId = typeof query.bundleId === "string" ? query.bundleId : "";
  const id = typeof query.id === "string" ? query.id : "";

  let record = bundleId ? findPackageAppByBundleId(bundleId) : undefined;
  if (!record && id) record = findPackageAppByAppId(id);
  if (!record) return undefined;
  return softwareFromRecord(record, platform);
}

/**
 * One package-app record as the Software shape the frontend renders; the
 * requested platform's build supplies version id, version, minimum OS, size and
 * release date (a tvOS build must not pass for an iOS lookup). Size is the
 * package's own on-disk size, not Apple's installed size.
 */
function softwareFromRecord(record: PackageAppRecord, platform?: Platform) {
  const build = buildForPlatform(record, platform);

  return {
    id: Number(record.appId),
    bundleID: record.bundleID,
    name: record.name ?? `App ${record.appId}`,
    version: build?.version ?? "",
    artistName: record.artistName ?? "",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: record.artworkUrl ?? "",
    screenshotUrls: [],
    minimumOsVersion: build?.minimumOsVersion ?? "",
    // The build's own id: a version number can name two different builds.
    externalVersionId: build?.externalVersionId,
    fileSizeBytes: build?.fileSizeBytes,
    releaseDate: build?.releaseDate ?? "",
    primaryGenreName: record.primaryGenreName ?? "",
    platform,
    metadataSource: "local" as const,
  };
}
