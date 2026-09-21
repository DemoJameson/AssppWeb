import { Router, Request, Response } from "express";
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
 * Accepted `platform` query values — the frontend's `Platform` values plus
 * ipatool's aliases. Unknown values are dropped rather than forwarded so a
 * stray parameter never reaches Apple.
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
    // The caller's platform choice is the authority: macOS and tvOS results
    // surfaced through a shared entity still report the platform asked for.
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
    );
    const data = await response.json();
    const results = (data.results ?? []).map((item: Record<string, any>) =>
      mapSoftware(item, platform),
    );
    // Delisted apps live in the package-app index, not the catalogue: merge
    // their name matches in on top, tagged so the list can say so — and never
    // when the storefront already lists the same app. A name match against the
    // index only proves we downloaded the app once, not that it was delisted:
    // the search term may simply not have matched (e.g. "sen" does not find
    // "SenPlayer"). Re-check each match by bundle id against the storefront —
    // if it is still there, use that data untagged; only when the storefront
    // has nothing do we tag it as a local record.
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
    );
    const data = await response.json();
    if (!data.resultCount || !data.results?.length) {
      // The storefront forgot the app — fall back to what past downloads'
      // compiled packages recorded about it, so delisted apps stay findable.
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
 * Builds a Software record from the package-app index when the storefront
 * knows nothing about the app: the compiled package is the authority on what
 * it contains, delisted or not. `metadataSource` tells the frontend where the
 * record came from so it can say so.
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
 * One package-app record as the Software shape the frontend renders: the
 * requested platform's build supplies the version id, version, minimum OS, size
 * and release date (a tvOS build must not pass for an iOS lookup), and
 * `metadataSource` tells the frontend where the record came from.
 *
 * The storefront knows nothing more to add — it has forgotten the app — so what
 * is left out here (the price, the description, the screenshots, the seller)
 * is left out because the package never carried it. `artistName` is the app's
 * own, and the UI falls back to it where a seller name would go.
 *
 * The size is the package's own on-disk size, not Apple's installed size: it is
 * what a download of this app from this instance would actually transfer, which
 * is the same number the downloads view prints under 大小.
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
    // The build's own id: what a detail view ties the record to when the list
    // offers a version — a version number can name two different builds.
    externalVersionId: build?.externalVersionId,
    fileSizeBytes: build?.fileSizeBytes,
    releaseDate: build?.releaseDate ?? "",
    primaryGenreName: record.primaryGenreName ?? "",
    platform,
    metadataSource: "local" as const,
  };
}
