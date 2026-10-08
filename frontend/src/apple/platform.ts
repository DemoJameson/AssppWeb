// The store platforms Apple distinguishes, mirroring ipatool's `Platform`
// (pkg/appstore/platform.go). Each gets its own Search/Lookup entity and MDM
// catalogue platform. visionOS surfaces via `xrosSoftware`; macOS has no MDM
// catalogue platform (ipatool's `metadataPlatform()` rejects it), so a macOS
// download skips the pin rather than asking the wrong catalogue.

import type { Platform } from "../types";

export const PLATFORMS: Platform[] = [
  "ios",
  "ipad",
  "tvos",
  "visionos",
  "macos",
];


/** Brand names, not translatable — every locale shows these verbatim. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  ios: "iOS",
  ipad: "iPadOS",
  tvos: "tvOS",
  visionos: "visionOS",
  macos: "macOS",
};

/** `entity` for the iTunes Search API — ipatool's `Platform.searchEntity()`. */
export function searchEntityFor(platform: Platform): string {
  switch (platform) {
    case "ios":
      return "software";
    case "ipad":
      return "iPadSoftware";
    case "tvos":
      // The storefront lists tvOS builds alongside the iOS app.
      return "software,tvSoftware";
    case "visionos":
      return "xrosSoftware";
    case "macos":
      return "macSoftware";
  }
}

/** `entity` for the iTunes Lookup API — ipatool's `Platform.lookupEntity()`. */
export function lookupEntityFor(platform: Platform): string {
  switch (platform) {
    case "ios":
      return "software";
    case "ipad":
      return "iPadSoftware";
    case "tvos":
      return "tvSoftware";
    case "visionos":
      return "xrosSoftware";
    case "macos":
      return "macSoftware";
  }
}

/**
 * `platform` for Apple's MDM catalogue lookup (the version pin). macOS returns
 * undefined (skip the pin); an unknown platform defaults to `enterprisestore`.
 */
export function metadataPlatformFor(platform?: Platform): string | undefined {
  switch (platform) {
    case "tvos":
      return "atv9";
    case "visionos":
      return "realityDevice";
    case "macos":
      return undefined;
    default:
      return "enterprisestore";
  }
}

/**
 * The MDM catalogues `lookupLatestExternalVersionId` consults, in order (mirrors
 * ipatool, e5211d6): tvOS stays on its Apple TV catalogue; iPhone/iPad (and the
 * default) try the enterprise catalogue then iphone/ipad. visionOS/macOS have none.
 */
export function mdmCataloguesFor(platform?: Platform): string[] | undefined {
  if (platform === "visionos" || platform === "macos") {
    return undefined;
  }

  const primary = metadataPlatformFor(platform);
  if (!primary) {
    return undefined;
  }

  if (platform === "tvos") {
    return [primary];
  }

  return [primary, "iphone", "ipad"];
}

/**
 * Whether the exchange must pin a platform-specific version first: tvOS/visionOS
 * share an adam id with iOS (an unpinned request returns the iOS ipa) and macOS
 * needs the Mac page; ios/ipad need none. Kept here so callers avoid the request graph.
 */
export function needsPlatformPin(platform?: Platform): boolean {
  return platform === "tvos" || platform === "visionos" || platform === "macos";
}

/**
 * Whether an artifact URL can be the requested platform's build: macOS is `.pkg`,
 * all else an IPA; the URL is what a reply says about its own platform, so this is
 * the check a *guessed* pin needs. The guess drops a mismatch, the download flow refuses.
 */
export function artifactMatchesPlatform(
  url: string,
  platform?: Platform,
): boolean {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return platform === "macos" ? path.endsWith(".pkg") : !path.endsWith(".pkg");
}

/**
 * Lenient reader for persisted settings and query strings: accepts ipatool's
 * aliases and returns undefined for anything unknown.
 */
export function parsePlatform(value: unknown): Platform | undefined {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "ios":
    case "iphone":
      return "ios";
    case "ipad":
      return "ipad";
    case "tvos":
    case "appletv":
      return "tvos";
    case "visionos":
      return "visionos";
    case "macos":
      return "macos";
    default:
      return undefined;
  }
}