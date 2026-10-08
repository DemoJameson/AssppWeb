// Apple's platform version lookup, mirroring ipatool's `lookupLatestExternalVersionID` and `lookupLatestMacOSExternalVersionID`.
// iOS/iPad/tvOS use the MDM catalogue at uclient-api.itunes.apple.com (p=mdm-lockup): iOS/iPad try the enterprise
// catalogue then the consumer iphone/ipad ones (some storefronts lack an enterprise listing), tvOS stays on atv9.
// visionOS/macOS instead read the storefront product page (apps.apple.com/{cc}/app/id{id}?platform=vision|mac):
// MDM carries no visionOS offers, and its legacy macOS lookup can return an iOS offer even with platform=osx.

import { appleRequest, type AppleResponse } from "./request";
import { apiGet } from "../api/client";
import { mdmCataloguesFor } from "./platform";
import type { Platform, Cookie } from "../types";

const LOOKUP_HOST = "uclient-api.itunes.apple.com";
const LOOKUP_PATH = "/WebObjects/MZStorePlatform.woa/wa/lookup";
const STOREFRONT_HOST = "apps.apple.com";

/**
 * Cap on storefront redirect hops before giving up, so a redirect loop fails
 * instead of hanging the lookup. Counts the hops followed: one request each,
 * plus the request whose redirect trips it.
 */
const MAX_STOREFRONT_REDIRECTS = 5;

/** The storefronts to consult after the account's own, from server config
 * (`STOREFRONT_FALLBACK_COUNTRIES`; CN by default, none configured disables it).
 * The version id is a global build identifier, so a reachable storefront
 * substitutes for the account's own. Read per lookup, never cached (an operator
 * change applies without a rebuild) nor shared (a hung request can't hold later ones).
 */
async function configuredStorefrontFallbacks(): Promise<string[]> {
  try {
    const settings = await apiGet<{ storefrontFallbackCountries?: unknown }>(
      "/api/settings",
    );
    const countries = settings?.storefrontFallbackCountries;
    if (!Array.isArray(countries)) return [];
    return countries
      .filter((country): country is string => typeof country === "string")
      .map((country) => country.toLowerCase())
      .filter((country) => /^[a-z]{2}$/.test(country));
  } catch {
    return [];
  }
}

/** Fetches a storefront page, following Apple's redirects (301 to the slug URL,
 * 302 to a reachable storefront); libcurl reports Location raw, so a relative one
 * is resolved against the storefront host. Thrown messages are internal — every
 * caller maps a failure to its own user-facing string (see `versionFinder`).
 */
async function fetchStorefrontPage(
  path: string,
  cookies?: Cookie[],
): Promise<AppleResponse> {
  for (let hop = 0; ; hop++) {
    const response = await appleRequest({
      method: "GET",
      host: STOREFRONT_HOST,
      path,
      cookies,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers["location"];
      if (location) {
        if (hop >= MAX_STOREFRONT_REDIRECTS) {
          throw new Error("storefront lookup was redirected too many times");
        }

        const url = new URL(location, `https://${STOREFRONT_HOST}`);
        // The chain must stay on the storefront, over https and its own port:
        // Apple answers these pages from `apps.apple.com` alone, so anything
        // else is not a hop of the chain the lookup set out on.
        if (url.protocol !== "https:" || url.host !== STOREFRONT_HOST) {
          throw new Error(
            `storefront lookup was redirected off ${STOREFRONT_HOST} (${url.origin})`,
          );
        }

        path = url.pathname + url.search;
        continue;
      }
    }

    return response;
  }
}

/** Runs `fetchOne` over the account's own storefront then the server fallbacks,
 * returning the first id that resolves (a storefront naming no build is no
 * answer, so the next is asked). The fallback list is read while the own
 * storefront is asked, never before, so no lookup pays a backend round trip
 * first; when none answers, the own storefront's failure is thrown.
 */
async function lookupAcrossStorefronts(
  countryCode: string,
  fetchOne: (country: string) => Promise<string | undefined>,
  platform: string,
): Promise<string | undefined> {
  const own = countryCode.toLowerCase();
  // Deliberately not awaited here: it rides beside the own-storefront attempt
  // below and is only awaited once that comes up short, so no lookup pays a
  // backend round trip first. The name says promise so the deferred `await`
  // reads as the choice it is, not as an omission.
  const fallbacksPromise = configuredStorefrontFallbacks();

  let firstError: Error | undefined;

  const attempt = async (country: string): Promise<string | undefined> => {
    try {
      return await fetchOne(country);
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
      return undefined;
    }
  };

  const ownVersionId = await attempt(own);
  if (ownVersionId) return ownVersionId;

  for (const country of await fallbacksPromise) {
    if (country === own) continue;

    const versionId = await attempt(country);
    if (versionId) return versionId;
  }

  throw firstError ?? new Error(`${platform} version lookup failed`);
}

/** Returns the newest external version id for an app, or undefined when Apple
 * answers without one (the caller then retries unpinned). visionOS goes through
 * the storefront product page, not the MDM catalogue; macOS is handled by {@link
 * lookupLatestMacOSVersionId}. iPhone/iPad walk the MDM catalogues from {@link
 * mdmCataloguesFor} in order, throwing once none answers so a failure surfaces.
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

/** The newest version id the platform's *own* source names — MDM catalogue for
 * iOS/iPad/tvOS, storefront product page for macOS/visionOS. What a caller ruling
 * an id out should ask: an id its own source names is that platform's build, so a
 * neighbour guess must never offer it. A source with nothing to say throws, which
 * such callers read as "nothing to exclude".
 */
export async function latestVersionIdForPlatform(
  appId: string | number,
  countryCode: string,
  platform: Platform,
  bundleId?: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  if (platform === "macos") {
    return lookupLatestMacOSVersionId(appId, countryCode, bundleId, cookies);
  }
  return lookupLatestExternalVersionId(appId, countryCode, platform, cookies);
}

/** The newest macOS external version id from the Mac storefront product page
 * (ipatool's `lookupLatestMacOSExternalVersionID`): the legacy MDM lookup can return
 * an iOS offer even with platform=osx, so the storefront is the only reliable source.
 * Own storefront first, then server fallbacks (the id is global, any account can
 * download); a fallback hit is still build-checked (see `assertMacOSPackage`).
 */
export async function lookupLatestMacOSVersionId(
  appId: string | number,
  countryCode: string,
  bundleId?: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  const id = String(appId);
  return lookupAcrossStorefronts(
    countryCode,
    (country) => fetchMacOSVersionId(id, country, bundleId, cookies),
    "macOS",
  );
}

async function fetchMacOSVersionId(
  id: string,
  countryCode: string,
  bundleId?: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  const query = new URLSearchParams({ platform: "mac" });
  const path = `/${countryCode.toLowerCase()}/app/id${id}?${query.toString()}`;

  const response = await fetchStorefrontPage(path, cookies);

  if (response.status !== 200) {
    throw new Error(`macOS version lookup returned ${response.status}`);
  }

  return findMacOSVersionId(response.body, id, bundleId);
}

/** The newest visionOS external version id from the Vision storefront product page.
 * Same storefront rules as macOS (see {@link lookupLatestMacOSVersionId}); the page
 * is parsed for a vision purchase configuration instead.
 */
async function lookupLatestVisionOSVersionId(
  appId: string | number,
  countryCode: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  const id = String(appId);
  return lookupAcrossStorefronts(
    countryCode,
    (country) => fetchVisionVersionId(id, country, cookies),
    "visionOS",
  );
}

async function fetchVisionVersionId(
  id: string,
  countryCode: string,
  cookies?: Cookie[],
): Promise<string | undefined> {
  const query = new URLSearchParams({ platform: "vision" });
  const path = `/${countryCode.toLowerCase()}/app/id${id}?${query.toString()}`;

  const response = await fetchStorefrontPage(path, cookies);

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
 * app id (ipatool's `findVisionExternalVersionID`): `metricsPlatformDisplayStyle`
 * "vision", `appPlatforms` listing "vision", and `buyParams.salableAdamId`.
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

/** Walks the storefront JSON for a macOS purchase configuration matching the app id
 * and bundle id (ipatool's `collectMacOSExternalVersions`): `appPlatforms` listing
 * "mac", `buyParams.salableAdamId` naming the app, and — when a bundle id is known —
 * a matching `bundleId`.
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
