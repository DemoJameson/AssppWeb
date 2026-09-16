import { Router, Request, Response } from "express";
import type { Platform } from "../types/index.js";

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
      res.json(null);
      return;
    }
    res.json(mapSoftware(data.results[0], platform));
  } catch (err) {
    console.error("Lookup error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Lookup request failed" });
  }
});

export default router;
