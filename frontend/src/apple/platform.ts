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
  ipad: "iPad",
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