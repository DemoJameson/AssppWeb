// The store platforms Apple distinguishes, mirroring ipatool's `Platform`
// (pkg/appstore/platform.go). Each platform gets its own iTunes Search entity,
// its own iTunes Lookup entity, and its own MDM catalogue platform for the
// version pin.
//
// visionOS apps surface through Apple's `xrosSoftware` entities, and macOS has
// no MDM catalogue platform at all — ipatool's `metadataPlatform()` rejects it,
// so a macOS download skips the pin rather than asking the wrong catalogue.

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
 * `platform` for Apple's MDM catalogue lookup (the version pin). macOS has no
 * entry here — undefined means the caller must skip the pin. An unknown
 * platform keeps the historical default, the enterprise catalogue.
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
 * The MDM catalogues `lookupLatestExternalVersionId` consults, in order.
 * Mirrors ipatool's `lookupLatestExternalVersionID` (e5211d6): tvOS stays on
 * its single Apple TV catalogue, while iPhone/iPad — and the default device
 * class — start at the enterprise catalogue and fall back to the consumer
 * iphone/ipad catalogues, because some storefronts have no enterprise listing
 * even when a consumer catalogue has the app. visionOS and macOS never reach
 * the MDM lookup, so they have no catalogues.
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
 * Whether the download exchange must pin a platform-specific version before
 * the first request. tvOS and visionOS builds share an adam id with the iOS
 * app, so an unpinned volumeStore request returns the iOS ipa. macOS apps can
 * share an adam id with the iOS app too, and the legacy MDM lookup returns an
 * iOS offer even with platform=osx, so the Mac storefront page selects the
 * native Mac offer. iOS/iPad are the default device class and need no pin.
 *
 * It lives here rather than next to the exchange so callers that only need the
 * rule — a hook deciding whether a download has to bring its own version id —
 * do not have to import the libcurl-backed request graph.
 */
export function needsPlatformPin(platform?: Platform): boolean {
  return platform === "tvos" || platform === "visionos" || platform === "macos";
}

/**
 * Whether a download artifact's URL can be the requested platform's build.
 * macOS packages are `.pkg` (xar containers, no IPAs); every other platform
 * ships an IPA. The URL is the one thing a download reply says about its own
 * platform, which is what makes it the check a *guessed* pin needs: an
 * external version id names its own platform, so a guess that reached another
 * platform's build still gets refused here.
 *
 * Both callers react differently on purpose: the pin guess drops such a
 * candidate (it is simply not this platform's build), while the download flow
 * refuses the whole request with a message (the user asked for this download).
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