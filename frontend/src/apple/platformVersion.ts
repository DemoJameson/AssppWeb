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

import { appleRequest, type AppleResponse } from "./request";
import { apiGet } from "../api/client";
import { mdmCataloguesFor } from "./platform";
import type { Platform, Cookie } from "../types";

const LOOKUP_HOST = "uclient-api.itunes.apple.com";
const LOOKUP_PATH = "/WebObjects/MZStorePlatform.woa/wa/lookup";
const STOREFRONT_HOST = "apps.apple.com";

/**
 * How many storefront redirects a lookup follows before giving up. The chains
 * are short — a canonical hop, sometimes a storefront one — so the cap only
 * exists to fail a loop instead of hanging the lookup. It counts the hops that
 * are followed: one request each, plus the request whose redirect trips it.
 */
const MAX_STOREFRONT_REDIRECTS = 5;

/**
 * The storefronts to consult after the account's own one, as the server
 * configures them (`STOREFRONT_FALLBACK_COUNTRIES`; the CN storefront by
 * default, none configured disables the fallback).
 *
 * Apple only serves the product page of a storefront it believes the request
 * comes from: from a mainland-China network every non-CN storefront path
 * (`/us/app/id…?platform=mac`, `/au/…`) is answered with a redirect to the CN
 * Today page, so an account in another country sees no offer from it at all —
 * for any app, not just the ones missing there. The external version id the
 * page carries is a global build identifier, not a per-country one: an account
 * in any country can download the build it names. So a storefront whose page
 * the network *can* reach is a valid substitute for the account's own, and the
 * lookup asks the account's country first and these afterwards.
 *
 * Read per lookup — never cached — so an operator change takes effect without a
 * rebuild; an unreachable server simply leaves the fallback out. Each lookup
 * reads for itself rather than sharing one read between them: a request that
 * never answers would otherwise hold every later lookup behind it, which is a
 * worse trade than asking twice for a list this small.
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

/**
 * Fetches a storefront page, resolving the redirects Apple answers these
 * paths with: the canonical 301 from the slug-less app path to its slug URL,
 * and the 302 from a storefront the network cannot reach to the one it can.
 * The page itself only appears at the end of the chain, and libcurl reports
 * the Location raw, so a relative one is resolved against the storefront
 * host.
 *
 * The messages the checks below throw are internal: every caller maps a failed
 * storefront lookup to its own user-facing string (see `versionFinder`), so
 * they are deliberately plain and unlocalized.
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
        // The next request carries the caller's cookies, so the chain stays on
        // the storefront, over https and on its own port: Apple answers these
        // pages from `apps.apple.com` alone, so anything else is not a hop of
        // the chain the lookup set out on.
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

/**
 * Runs `fetchOne` over the account's own storefront and the server-configured
 * fallbacks in order, returning the first id that resolves. A storefront that
 * answers without naming a build is not an answer either, so the next one is
 * asked — `fetchOne` may report that by throwing or by returning undefined.
 *
 * When none of them answers, the failure the account's own storefront reported
 * is the one thrown: it is the answer about the app the caller asked about.
 *
 * The fallback list is read while the account's own storefront is being asked,
 * never before it: it is only needed once that attempt has come up short, and
 * waiting for it first would put a backend round trip in front of every lookup.
 */
async function lookupAcrossStorefronts(
  countryCode: string,
  fetchOne: (country: string) => Promise<string | undefined>,
  platform: string,
): Promise<string | undefined> {
  const own = countryCode.toLowerCase();
  // Deliberately not awaited here: the settings request rides *beside* the
  // own-storefront attempt below, and is only awaited once that attempt has
  // come up short. Awaiting it now would put a backend round trip in front of
  // every lookup; the name says promise so the deferred `await` reads as the
  // choice it is, not as an omission.
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
 * The newest version id the platform's *own* source names for an app — the MDM
 * catalogue for iOS/iPad/tvOS, the storefront product page for macOS and
 * visionOS — whichever `platform` asks for.
 *
 * This is the single dispatch behind the pin lookups, and it is what a caller
 * that only wants to *rule an id out* should ask: an id a platform's own source
 * names is that platform's build, so a neighbour guess for another platform must
 * never offer it. Unlike the lookups below it is not the answer to "can we
 * download this platform" — a source that has nothing to say throws, and
 * callers that are only ruling ids out treat that as "nothing to exclude".
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

/**
 * Returns the newest macOS external version id from the Mac storefront product
 * page. Mirrors ipatool's `lookupLatestMacOSExternalVersionID`: the legacy MDM
 * lookup can return an iOS offer even with platform=osx, so the storefront is
 * the only reliable source.
 *
 * The account's own storefront is asked first; when that page cannot name a Mac
 * build — unreachable, redirected to another country's page, or carrying no Mac
 * offer — the server-configured fallback storefronts are asked in turn, because
 * the id is a global build identifier any account can download. When none of
 * them answers, the failure the account's own storefront reported is the one
 * thrown: it is the answer about the app the caller asked about.
 *
 * Asking the account's own storefront first also means the fallback is consulted
 * for an app that storefront simply offers no Mac build of — not only when its
 * page could not be reached. So "this platform has a build" can come from a
 * storefront that is not the account's own; the id is a global build
 * identifier, so the build it names is still the account's to download, and what
 * comes back is checked against the platform asked for (see
 * `assertMacOSPackage`).
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

/**
 * Returns the newest visionOS external version id from the Vision storefront
 * product page. The same storefront rules as macOS apply (see
 * {@link lookupLatestMacOSVersionId}); the page is parsed for a vision
 * purchase configuration instead.
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
