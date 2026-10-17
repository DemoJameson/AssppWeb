// Apple's platform version lookup, mirroring ipatool's `lookupLatestExternalVersionID` and `lookupLatestMacOSExternalVersionID`.
// iOS/iPad/tvOS use the MDM catalogue at uclient-api.itunes.apple.com (p=mdm-lockup): iOS/iPad try the enterprise
// catalogue then the consumer iphone/ipad ones (some storefronts lack an enterprise listing), tvOS stays on atv9.
// When every iOS/iPad MDM catalogue has no app or offer, the public apps.apple.com catalog API is the final fallback.
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

/** The public App Store catalog fallback is rate limited in practice, so a
 * successful answer is reused for Apple's advertised 15-minute cache window.
 * A 429 pauses the fallback for a minute (or Retry-After, capped at five).
 */
const IOS_CATALOG_CACHE_TTL_MS = 15 * 60_000;
const IOS_CATALOG_RATE_LIMIT_COOLDOWN_MS = 60_000;
const IOS_CATALOG_MAX_COOLDOWN_MS = 5 * 60_000;
/** The fallback is a last resort and the public endpoint rate-limits bursts. */
const IOS_CATALOG_MAX_CONCURRENT = 1;

type IOSCatalogPlatform = "iphone" | "ipad";

interface IOSCatalogCacheEntry {
  expiresAt: number;
  /** Undefined records a cached HTTP 404, so a missing app is not hammered. */
  versionId?: string;
}

interface IOSCatalogResponse {
  data?: Array<{
    id?: string;
    type?: string;
    attributes?: {
      deviceFamilies?: string[];
      platformAttributes?: {
        ios?: {
          bundleId?: string;
          externalVersionId?: string | number;
        };
      };
    };
  }>;
}

const iosCatalogCache = new Map<string, IOSCatalogCacheEntry>();
const iosCatalogInFlight = new Map<string, Promise<string>>();
const iosCatalogQueue: Array<() => void> = [];
let iosCatalogActive = 0;
let iosCatalogCooldownUntil = 0;

class MDMVersionLookupExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MDMVersionLookupExhaustedError";
  }
}

class IOSCatalogAppNotFoundError extends Error {
  constructor() {
    super("iOS catalog lookup returned HTTP 404");
    this.name = "IOSCatalogAppNotFoundError";
  }
}

function acquireIOSCatalogSlot(): Promise<void> {
  if (iosCatalogActive < IOS_CATALOG_MAX_CONCURRENT) {
    iosCatalogActive++;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    iosCatalogQueue.push(() => {
      iosCatalogActive++;
      resolve();
    });
  });
}

function releaseIOSCatalogSlot(): void {
  iosCatalogActive = Math.max(0, iosCatalogActive - 1);
  iosCatalogQueue.shift()?.();
}

/** Test hook: keeps one test's cached answer or 429 cooldown out of the next. */
export function resetPlatformVersionLookupCache(): void {
  iosCatalogCache.clear();
  iosCatalogInFlight.clear();
  iosCatalogQueue.length = 0;
  iosCatalogActive = 0;
  iosCatalogCooldownUntil = 0;
}

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
 * mdmCataloguesFor} in order, then try the public App Store catalog when every
 * MDM catalogue has answered without an app or offer.
 */
export async function lookupLatestExternalVersionId(
  appId: string | number,
  countryCode: string,
  platform?: Platform,
  cookies?: Cookie[],
  bundleId?: string,
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

  try {
    return await lookupLatestMDMVersionId(
      appId,
      countryCode,
      catalogues,
      cookies,
    );
  } catch (error) {
    if (
      !(error instanceof MDMVersionLookupExhaustedError) ||
      !catalogPlatformFor(platform)
    ) {
      throw error;
    }

    try {
      return await lookupLatestIOSCatalogVersionId(
        appId,
        countryCode,
        platform,
        bundleId,
      );
    } catch (catalogError) {
      // A 404 is a definitive answer about this app, not a transport failure.
      // Keep the existing "all MDM catalogues exhausted" message for callers
      // that already use it to mean "no version for this platform".
      if (catalogError instanceof IOSCatalogAppNotFoundError) throw error;

      throw new Error(
        `${error.message}; iOS catalog fallback failed: ${messageOf(catalogError)}`,
      );
    }
  }
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
  return lookupLatestExternalVersionId(
    appId,
    countryCode,
    platform,
    cookies,
    bundleId,
  );
}

function catalogPlatformFor(platform?: Platform): IOSCatalogPlatform | undefined {
  if (platform === "ipad") return "ipad";
  if (platform === "ios" || platform === undefined) return "iphone";
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rateLimitCooldownMs(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return IOS_CATALOG_RATE_LIMIT_COOLDOWN_MS;

  if (/^[0-9]+$/.test(text)) {
    return Math.min(
      Math.max(Number(text) * 1000, 1000),
      IOS_CATALOG_MAX_COOLDOWN_MS,
    );
  }

  const until = Date.parse(text);
  if (Number.isFinite(until)) {
    return Math.min(
      Math.max(until - Date.now(), 1000),
      IOS_CATALOG_MAX_COOLDOWN_MS,
    );
  }

  return IOS_CATALOG_RATE_LIMIT_COOLDOWN_MS;
}

async function lookupLatestIOSCatalogVersionId(
  appId: string | number,
  countryCode: string,
  platform: Platform | undefined,
  bundleId?: string,
): Promise<string> {
  const catalogPlatform = catalogPlatformFor(platform);
  if (!catalogPlatform) {
    throw new Error("iOS catalog fallback only supports iOS and iPad");
  }

  const id = String(appId);
  const country = countryCode.toLowerCase();
  const key = `${id}|${country}|${catalogPlatform}|${bundleId ?? ""}`;
  const cached = iosCatalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.versionId) return cached.versionId;
    throw new IOSCatalogAppNotFoundError();
  }
  if (cached) iosCatalogCache.delete(key);

  if (Date.now() < iosCatalogCooldownUntil) {
    throw new Error("iOS catalog lookup is cooling down after HTTP 429");
  }

  const existing = iosCatalogInFlight.get(key);
  if (existing) return existing;

  let request: Promise<string>;
  request = (async () => {
    await acquireIOSCatalogSlot();
    try {
      // A request may have waited behind another app's 429 response.
      if (Date.now() < iosCatalogCooldownUntil) {
        throw new Error("iOS catalog lookup is cooling down after HTTP 429");
      }

      return await requestIOSCatalogVersionId(
        id,
        country,
        catalogPlatform,
        key,
        bundleId,
      );
    } finally {
      releaseIOSCatalogSlot();
    }
  })().finally(() => {
    if (iosCatalogInFlight.get(key) === request) {
      iosCatalogInFlight.delete(key);
    }
  });
  iosCatalogInFlight.set(key, request);
  return request;
}

async function requestIOSCatalogVersionId(
  id: string,
  country: string,
  catalogPlatform: IOSCatalogPlatform,
  cacheKey: string,
  bundleId?: string,
): Promise<string> {
  const query = new URLSearchParams({ platform: catalogPlatform });
  const response = await fetchStorefrontPage(
    `/api/apps/v1/catalog/${encodeURIComponent(country)}/apps/${encodeURIComponent(id)}?${query.toString()}`,
  );

  if (response.status === 429) {
    iosCatalogCooldownUntil = Math.max(
      iosCatalogCooldownUntil,
      Date.now() + rateLimitCooldownMs(response.headers?.["retry-after"]),
    );
    throw new Error("iOS catalog lookup returned HTTP 429");
  }

  if (response.status === 404) {
    iosCatalogCache.set(cacheKey, {
      expiresAt: Date.now() + IOS_CATALOG_CACHE_TTL_MS,
    });
    throw new IOSCatalogAppNotFoundError();
  }

  if (response.status !== 200) {
    throw new Error(`iOS catalog lookup returned HTTP ${response.status}`);
  }

  let parsed: IOSCatalogResponse;
  try {
    parsed = JSON.parse(response.body) as IOSCatalogResponse;
  } catch {
    throw new Error("iOS catalog lookup returned invalid JSON");
  }

  if (!Array.isArray(parsed.data) || parsed.data.length !== 1) {
    throw new Error("iOS catalog lookup must return exactly one app");
  }

  const item = parsed.data[0];
  if (item.id !== id || item.type !== "apps") {
    throw new Error("iOS catalog lookup returned a different app");
  }

  const attributes = item.attributes;
  if (
    !attributes ||
    !Array.isArray(attributes.deviceFamilies) ||
    !attributes.deviceFamilies.includes(catalogPlatform)
  ) {
    throw new Error("iOS catalog lookup returned no metadata for the requested platform");
  }

  const platformAttributes = attributes.platformAttributes?.ios;
  if (!platformAttributes) {
    throw new Error("iOS catalog lookup returned no iOS platform metadata");
  }

  if (bundleId && platformAttributes.bundleId !== bundleId) {
    throw new Error("iOS catalog lookup returned a different bundle identifier");
  }

  const versionId = String(platformAttributes.externalVersionId ?? "");
  if (!/^[1-9][0-9]*$/.test(versionId)) {
    throw new Error("iOS catalog lookup returned no valid external version id");
  }

  iosCatalogCache.set(cacheKey, {
    expiresAt: Date.now() + IOS_CATALOG_CACHE_TTL_MS,
    versionId,
  });
  return versionId;
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

  throw new MDMVersionLookupExhaustedError(
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
