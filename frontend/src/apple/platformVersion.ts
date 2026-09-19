// Apple's platform version lookup, mirroring ipatool's
// `lookupLatestExternalVersionID` and `lookupLatestMacOSExternalVersionID`
// (pkg/appstore/appstore_platform_version_lookup.go,
//  pkg/appstore/appstore_macos_version_lookup.go).
//
// Three transports, one per platform family:
//
//   - iOS / iPad / tvOS — the MDM catalogue at uclient-api.itunes.apple.com
//     with p=mdm-lockup and a per-platform `platform` parameter. iOS/iPad start
//     at the enterprise catalogue and fall back to the consumer iphone/ipad
//     catalogues (some storefronts have no enterprise listing); tvOS stays on
//     the single atv9 catalogue. This is what the redownload fallback needs.
//
//   - visionOS — Apple's MDM catalogue does not carry visionOS offers, so
//     ipatool short-circuits to the storefront product page at
//     apps.apple.com/{cc}/app/id{id}?platform=vision, reads the
//     serialized-server-data JSON and walks the purchaseConfiguration tree
//     for a vision offer whose buyParams name the requested app.
//
//   - macOS — the legacy MDM lookup can return an iOS offer even with
//     platform=osx, so ipatool uses the Mac storefront product page
//     (apps.apple.com/{cc}/app/id{id}?platform=mac) and selects the native
//     Mac offer the same way.

import { appleRequest } from "./request";
import { mdmCataloguesFor } from "./platform";
import type { Platform, Cookie } from "../types";

const LOOKUP_HOST = "uclient-api.itunes.apple.com";
const LOOKUP_PATH = "/WebObjects/MZStorePlatform.woa/wa/lookup";
const STOREFRONT_HOST = "apps.apple.com";

/**
 * Returns the newest external version id for an app, or undefined when Apple
 * answers without one (the caller then retries without a pinned version rather
 * than failing outright).
 *
 * visionOS is routed through the storefront product page, not the MDM
 * catalogue — ipatool's `lookupLatestExternalVersionID` does the same.
 * macOS is not handled here; use {@link lookupLatestMacOSVersionId}.
 *
 * iPhone/iPad (and the default device class) walk the MDM catalogues returned
 * by {@link mdmCataloguesFor} in order; the lookup throws with the catalogues
 * tried once none of them answers, so a failure surfaces to the caller instead
 * of reading as "no version".
 */
export async function lookupLatestExternalVersionId(
  appId: string | number,
  countryCode: string,
  platform?: Platform,
  cookies?: Cookie[],
): Promise<string | undefined> {
  if (platform === "visionos") {
    return lookupLatestVisionOSVersionId(appId, countryCode, cookies);
  }

  if (platform === "macos") {
    return undefined;
  }

  const catalogues = mdmCataloguesFor(platform);
  if (!catalogues) {
    return undefined;
  }

  return lookupLatestMDMVersionId(appId, countryCode, catalogues, cookies);
}

/**
 * Returns the newest macOS external version id from the Mac storefront product
 * page. Mirrors ipatool's `lookupLatestMacOSExternalVersionID`: the legacy MDM
 * lookup can return an iOS offer even with platform=osx, so the storefront is
 * the only reliable source.
 */
export async function lookupLatestMacOSVersionId(
  appId: string | number,
  countryCode: string,
  bundleId?: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  const id = String(appId);
  const query = new URLSearchParams({ platform: "mac" });
  const path = `/${countryCode.toLowerCase()}/app/id${id}?${query.toString()}`;

  const response = await appleRequest({
    method: "GET",
    host: STOREFRONT_HOST,
    path,
    cookies,
  });

  if (response.status !== 200) {
    throw new Error(`macOS version lookup returned ${response.status}`);
  }

  return findMacOSVersionId(response.body, id, bundleId);
}

async function lookupLatestVisionOSVersionId(
  appId: string | number,
  countryCode: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  const id = String(appId);
  const query = new URLSearchParams({ platform: "vision" });
  const path = `/${countryCode.toLowerCase()}/app/id${id}?${query.toString()}`;

  const response = await appleRequest({
    method: "GET",
    host: STOREFRONT_HOST,
    path,
    cookies,
  });

  if (response.status !== 200) {
    throw new Error(`visionOS version lookup returned ${response.status}`);
  }

  return findVisionVersionId(response.body, id);
}

async function lookupLatestMDMVersionId(
  appId: string | number,
  countryCode: string,
  catalogues: string[],
  cookies?: Cookie[],
): Promise<string | undefined> {
  const id = String(appId);
  let lastError: Error | undefined;

  for (const catalogue of catalogues) {
    const query = new URLSearchParams({
      version: "2",
      id,
      p: "mdm-lockup",
      caller: "MDM",
      platform: catalogue,
      cc: countryCode.toLowerCase(),
      l: "en",
    });

    const response = await appleRequest({
      method: "GET",
      host: LOOKUP_HOST,
      path: `${LOOKUP_PATH}?${query.toString()}`,
      cookies,
    });

    if (response.status !== 200) {
      throw new Error(`Version lookup returned ${response.status}`);
    }

    const parsed = JSON.parse(response.body) as {
      results?: Record<
        string,
        {
          offers?: Array<{
            version?: { externalId?: string | number };
            buyParams?: string;
          }>;
        }
      >;
    };

    const item = parsed.results?.[id];
    if (!item) {
      lastError = new Error("Version lookup returned no app");
      continue;
    }

    if (!item.offers || item.offers.length === 0) {
      lastError = new Error("Version lookup returned no offers");
      continue;
    }

    const offer = item.offers[0];
    const externalId = offer.version?.externalId;
    if (externalId !== undefined && externalId !== null && externalId !== "") {
      return String(externalId);
    }

    const fromBuyParams = buyParamsExternalVersionId(offer.buyParams);
    if (fromBuyParams) {
      return fromBuyParams;
    }

    // An offer with no resolvable version id is a real answer about a real app,
    // not a signal to try another catalogue.
    throw new Error("Version lookup returned no external version id");
  }

  throw new Error(
    `app ${id} in storefront ${countryCode} (catalogs: ${catalogues.join(", ")}): ${lastError?.message ?? "no catalogue answered"}`,
  );
}

function buyParamsExternalVersionId(buyParams?: string): string | undefined {
  if (!buyParams) {
    return undefined;
  }
  return new URLSearchParams(buyParams).get("appExtVrsId") ?? undefined;
}

/**
 * Extracts the JSON content of the `<script id="serialized-server-data">`
 * element from an Apple storefront HTML page. Mirrors ipatool's
 * `serializedServerData`.
 */
function serializedServerData(html: string): string {
  const marker = 'id="serialized-server-data"';
  let markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    markerIndex = html.indexOf("id='serialized-server-data'");
  }
  if (markerIndex === -1) {
    throw new Error("serialized server data was not found");
  }

  const scriptStart = html.lastIndexOf("<script", markerIndex);
  if (scriptStart === -1) {
    throw new Error("serialized server data script was not found");
  }

  const contentStart = html.indexOf(">", markerIndex);
  if (contentStart === -1) {
    throw new Error("serialized server data script is malformed");
  }

  const contentEnd = html.indexOf("</script>", contentStart + 1);
  if (contentEnd === -1) {
    throw new Error("serialized server data script is not closed");
  }

  return html.slice(contentStart + 1, contentEnd).trim();
}

/**
 * Walks the storefront JSON for a visionOS purchase configuration matching the
 * app id. Mirrors ipatool's `findVisionExternalVersionID`: the configuration
 * must declare `metricsPlatformDisplayStyle: "vision"`, list `"vision"` in
 * `appPlatforms`, and name the app in `buyParams.salableAdamId`.
 */
function findVisionVersionId(body: string, appId: string): string | undefined {
  const data = serializedServerData(body);
  const value = JSON.parse(data);

  const result = walkVision(value, appId);
  if (result === undefined) {
    throw new Error("visionOS purchase configuration was not found");
  }
  if (result === "") {
    throw new Error("visionOS purchase configuration has no external version id");
  }
  return result;
}

function walkVision(value: unknown, appId: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walkVision(item, appId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const config = obj.purchaseConfiguration;
    if (config !== null && typeof config === "object") {
      const found = visionVersionFromConfig(config as Record<string, unknown>, appId);
      if (found !== undefined) return found;
    }
    for (const child of Object.values(obj)) {
      const found = walkVision(child, appId);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function visionVersionFromConfig(
  config: Record<string, unknown>,
  appId: string,
): string | undefined {
  if (config.metricsPlatformDisplayStyle !== "vision") return undefined;

  const platforms = config.appPlatforms;
  if (!Array.isArray(platforms) || !platforms.includes("vision")) return undefined;

  const buyParams = config.buyParams;
  if (typeof buyParams !== "string" || buyParams === "") return undefined;

  const params = new URLSearchParams(buyParams);
  if (params.get("salableAdamId") !== appId) return undefined;

  return params.get("appExtVrsId") ?? undefined;
}

/**
 * Walks the storefront JSON for a macOS purchase configuration matching the app
 * id and bundle id. Mirrors ipatool's `collectMacOSExternalVersions`: the
 * configuration must list `"mac"` in `appPlatforms`, and `buyParams` must name
 * the app via `salableAdamId`. When a bundle id is known, it must match too.
 */
function findMacOSVersionId(
  body: string,
  appId: string,
  bundleId?: string,
): string | undefined {
  const data = serializedServerData(body);
  const value = JSON.parse(data);

  const versions = new Set<string>();
  collectMacOSVersions(value, appId, bundleId, versions);

  if (versions.size === 0) {
    throw new Error(
      "macOS purchase configuration has no external version id for the requested app",
    );
  }
  if (versions.size > 1) {
    throw new Error(
      "macOS purchase configurations contain conflicting external version ids",
    );
  }
  return versions.values().next().value;
}

function collectMacOSVersions(
  value: unknown,
  appId: string,
  bundleId: string | undefined,
  versions: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMacOSVersions(item, appId, bundleId, versions);
    return;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const config = obj.purchaseConfiguration;
    if (config !== null && typeof config === "object") {
      macOSVersionFromConfig(config as Record<string, unknown>, appId, bundleId, versions);
    }
    for (const child of Object.values(obj)) {
      collectMacOSVersions(child, appId, bundleId, versions);
    }
  }
}

function macOSVersionFromConfig(
  config: Record<string, unknown>,
  appId: string,
  bundleId: string | undefined,
  versions: Set<string>,
): void {
  const platforms = config.appPlatforms;
  if (!Array.isArray(platforms) || !platforms.includes("mac")) return;

  const configBundleId = config.bundleId;
  if (bundleId && configBundleId !== bundleId) return;

  const buyParams = config.buyParams;
  if (typeof buyParams !== "string" || buyParams === "") return;

  const params = new URLSearchParams(buyParams);
  if (params.get("salableAdamId") !== appId) return;

  const version = params.get("appExtVrsId");
  if (version && /^\d+$/.test(version) && version !== "0") {
    versions.add(version);
  }
}
