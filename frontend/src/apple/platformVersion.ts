// Apple's storefront catalogue lookup.
//
// Needed before the redownload fallback in the download flow: that endpoint
// names the version it should serve via `appExtVrsId`, and the reply that would
// normally carry it (the volumeStore document) is the very thing that failed.
// Mirrors ApplePackage's `PlatformVersionLookup` and ipatool's platform version
// lookup, which both pin the newest external version id before the first
// redownload.

import { appleRequest } from "./request";

const LOOKUP_HOST = "uclient-api.itunes.apple.com";
const LOOKUP_PATH = "/WebObjects/MZStorePlatform.woa/wa/lookup";

/** The platform Apple's MDM catalogue is asked for; matches ipatool. */
const LOOKUP_PLATFORM = "enterprisestore";

/**
 * Returns the newest external version id for an app, or undefined when Apple
 * answers without one (the caller then retries without a pinned version rather
 * than failing outright).
 */
export async function lookupLatestExternalVersionId(
  appId: string | number,
  countryCode: string,
): Promise<string | undefined> {
  const id = String(appId);
  const query = new URLSearchParams({
    version: "2",
    id,
    p: "mdm-lockup",
    caller: "MDM",
    platform: LOOKUP_PLATFORM,
    cc: countryCode.toLowerCase(),
    l: "en",
  });

  const response = await appleRequest({
    method: "GET",
    host: LOOKUP_HOST,
    path: `${LOOKUP_PATH}?${query.toString()}`,
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

  const offer = parsed.results?.[id]?.offers?.[0];
  const externalId = offer?.version?.externalId;
  if (externalId !== undefined && externalId !== null) {
    return String(externalId);
  }

  // Some offers only carry the id inside the purchase parameters.
  return buyParamsExternalVersionId(offer?.buyParams);
}

function buyParamsExternalVersionId(buyParams?: string): string | undefined {
  if (!buyParams) {
    return undefined;
  }
  return new URLSearchParams(buyParams).get("appExtVrsId") ?? undefined;
}
