// The shared download-product exchange, mirroring ipatool's
// `sendDownloadProduct` (pkg/appstore/appstore_download_product.go). It backs
// Download, ListVersions and GetVersionMetadata, so callers supply a pin (or "")
// and apply their own failure mapping to the reply.

import type { Account, Software, Cookie } from "../types";
import { appleRequest, type AppleRequestOptions, type AppleResponse } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag } from "./bag";
import {
  AppleUnreachableError,
  DownloadError,
  PlatformVersionUnavailableError,
  UnexpectedAppleResponseError,
} from "./errors";
import {
  lookupLatestExternalVersionId,
  lookupLatestMacOSVersionId,
} from "./platformVersion";
import { withRecordedFallback } from "./versionPins";
import { needsPlatformPin } from "./platform";
import { needsVersionExchange } from "../utils/software";

import {
  REDOWNLOAD_PRODUCT_PATH,
  UPDATE_PRODUCT_PATH,
  downloadDispatchEndpoint,
  isAppleHost,
  storeIdToCountry,
  volumeStoreEndpoint,
  type StoreDownloadEndpoint,
} from "./config";
import i18n from "../i18n";

// Error types live in `errors.ts` (importable without the libcurl graph) and are
// re-exported here so existing import sites keep working.
export { DownloadError, UnexpectedAppleResponseError };

/** Apple's own cap on the number of redirects it will route a download through. */
const MAX_REDIRECTS = 10;

export interface DownloadSession {
  account: Account;
  app: Software;
  cookies: Cookie[];
}

export interface DownloadReply {
  status: number;
  /** Parsed plist, or null when the body was not a plist. */
  data: Record<string, any> | null;
  body: string;
  headers: Record<string, string>;
  rawHeaders: [string, string][];
  /** host + path of the request that produced this reply, for diagnostics. */
  endpoint: string;
}

export function createDownloadSession(
  account: Account,
  app: Software,
): DownloadSession {
  return { account, app, cookies: [...account.cookies] };
}

/**
 * volumeStore is primary but not the only endpoint: it answers without a download
 * item for unowned apps and can report one unavailable, so the bag chains
 * redownload then updateProduct (serving pinned versions) on an empty/unavailable
 * reply — not on a failureType or message, which is a real answer returned as-is.
 */
export async function requestDownloadProduct(
  session: DownloadSession,
  pinnedVersionId: string,
): Promise<DownloadReply> {
  const { account } = session;
  const guid = account.deviceIdentifier;

  let externalVersionId = pinnedVersionId;

  // volumeStore answers by the account's device class (iOS by default), not the
  // requested platform: an unpinned tvOS/visionOS request returns the iOS ipa, so
  // pin that platform's version first. macOS ships under its own adam ids (no pin).
  if (!externalVersionId && needsPlatformPin(session.app.platform)) {
    externalVersionId = await pinnedLatestVersionId(session);
  }

  // A request Apple never answered (the storefront host's address pool is the
  // one that goes silent; see AGENTS.md) says nothing about this endpoint, and the
  // fallbacks live on another host, so the next one is a real alternative; anything
  // Apple *answered* stays with the shape checks below.
  let volumeStoreReply: DownloadReply | null = null;
  let volumeStoreFailure: unknown;
  try {
    volumeStoreReply = await sendDownloadRequest(
      session,
      volumeStoreEndpoint(account.pod, guid),
      externalVersionId,
    );
  } catch (error) {
    if (!(error instanceof AppleUnreachableError)) throw error;
    volumeStoreFailure = error;
  }

  if (
    volumeStoreReply &&
    !isEmptyDownloadResponse(volumeStoreReply) &&
    !isUnavailableDownloadResponse(volumeStoreReply)
  ) {
    return volumeStoreReply;
  }

  const bag = await fetchBag(guid);
  // Nothing advertised to fall back to: report what volumeStore said — or, when
  // it never got through, the transport failure itself.
  if (!bag.redownloadEndpoint) {
    if (volumeStoreReply) return volumeStoreReply;
    throw volumeStoreFailure;
  }

  const redownload = dispatchEndpoint(
    bag.redownloadEndpoint,
    REDOWNLOAD_PRODUCT_PATH,
    guid,
  );

  // Unpinned redownloads can fail or return a tvOS package, so pin the current
  // iOS build first — the volumeStore reply that would carry the version id is
  // exactly what came back empty (or never arrived).
  if (!externalVersionId) {
    try {
      externalVersionId = await pinnedLatestVersionId(session);
    } catch (error) {
      // Reached only while recovering: if volumeStore never answered, the pin
      // lookup fails for the same reason, so report that real failure instead of
      // "no build for this platform" (the empty-reply path keeps the lookup's answer).
      throw volumeStoreFailure ?? error;
    }
  }

  let redownloadReply: DownloadReply;
  try {
    redownloadReply = await sendDownloadRequest(
      session,
      redownload,
      externalVersionId,
    );
  } catch (error) {
    if (
      bag.updateEndpoint &&
      externalVersionId &&
      (isEmptyRedownloadError(error) || error instanceof AppleUnreachableError)
    ) {
      return sendUpdateProduct(
        session,
        dispatchEndpoint(bag.updateEndpoint, UPDATE_PRODUCT_PATH, guid),
        externalVersionId,
      );
    }
    throw error;
  }

  if (
    bag.updateEndpoint &&
    externalVersionId &&
    isUnavailableDownloadResponse(redownloadReply)
  ) {
    return sendUpdateProduct(
      session,
      dispatchEndpoint(bag.updateEndpoint, UPDATE_PRODUCT_PATH, guid),
      externalVersionId,
    );
  }

  return redownloadReply;
}

/**
 * Serves pinned versions when redownload comes up empty; the reply is validated
 * first — exactly one item, for the requested app, version and bundle id.
 */
async function sendUpdateProduct(
  session: DownloadSession,
  endpoint: StoreDownloadEndpoint,
  externalVersionId: string,
): Promise<DownloadReply> {
  const reply = await sendDownloadRequest(session, endpoint, externalVersionId);

  if (failureTypeOf(reply) !== "") return reply;

  const customerMessage = customerMessageOf(reply);
  if (customerMessage !== "") {
    throw new DownloadError(customerMessage);
  }

  if (reply.status !== 200) {
    throw new DownloadError(
      i18n.t("errors.download.downloadFailed", { failureType: `HTTP ${reply.status}` }),
    );
  }

  const items = itemsOf(reply);
  const metadata = (items[0]?.metadata ?? {}) as Record<string, any>;
  const bundleId = metadata.softwareVersionBundleId;
  const matchesRequestedApp =
    items.length === 1 &&
    String(metadata.itemId) === String(session.app.id) &&
    String(metadata.softwareVersionExternalIdentifier) === externalVersionId &&
    typeof bundleId === "string" &&
    bundleId !== "" &&
    (!session.app.bundleID || bundleId === session.app.bundleID);

  if (!matchesRequestedApp) {
    throw new DownloadError(i18n.t("errors.download.updateMismatch"));
  }

  return reply;
}

async function sendDownloadRequest(
  session: DownloadSession,
  endpoint: StoreDownloadEndpoint,
  externalVersionId: string,
): Promise<DownloadReply> {
  const { account, app } = session;

  const payload: Record<string, any> = {
    creditDisplay: "",
    guid: account.deviceIdentifier,
    salableAdamId: app.id,
    serialNumber: "0",
  };

  if (externalVersionId) {
    payload[endpoint.externalVersionIdKey] = externalVersionId;
  }

  const response = await followRedirects(session, {
    method: "POST",
    host: endpoint.host,
    path: endpoint.path,
    headers: {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
    },
    body: buildPlist(payload),
  });

  session.cookies = extractAndMergeCookies(response.rawHeaders, session.cookies);

  return toReply(response, endpoint);
}

/**
 * Apple answers the first request with a redirect; the original POST is replayed
 * at the advertised location (the volumeStore hop is a pod hand-off expecting the
 * same body). A redirect with no Location is returned untouched, matching ipatool.
 */
async function followRedirects(
  session: DownloadSession,
  request: Omit<AppleRequestOptions, "cookies">,
): Promise<AppleResponse> {
  let host = request.host;
  let path = request.path;

  for (let hop = 0; ; hop++) {
    const response = await appleRequest({ ...request, host, path, cookies: session.cookies });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers["location"];
    if (!location) return response;

    if (hop >= MAX_REDIRECTS) {
      throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
    }

    const url = new URL(location, `https://${host}`);
    // The request carries the session cookies and the DSID header, and a hop off
    // Apple's domains would hand both to an unknown host — so it is refused and
    // the response returned as-is, like a redirect with no Location.
    if (!isAppleHost(url.hostname)) {
      console.warn(
        `[download] refused a redirect from ${host} to ${url.hostname}: not an Apple domain`,
      );
      return response;
    }
    host = url.hostname;
    path = url.pathname + url.search;
  }
}

function toReply(
  response: AppleResponse,
  endpoint: StoreDownloadEndpoint,
): DownloadReply {
  const reply: DownloadReply = {
    status: response.status,
    data: null,
    body: response.body,
    headers: response.headers,
    rawHeaders: response.rawHeaders,
    endpoint: `${endpoint.host}${endpoint.path}`,
  };

  if (response.status === 429) {
    throw new DownloadError(
      `rate limited by Apple (HTTP 429): ${bodySnippet(response.body)}`,
    );
  }

  // A 3xx that survived redirect-following has no Location: return it payload-less,
  // like ipatool.
  if (response.status >= 300 && response.status < 400) return reply;

  let data: Record<string, any> | null = null;
  try {
    data = parsePlist(response.body) as Record<string, any>;
  } catch {
    data = null;
  }

  if (!data) {
    throw new UnexpectedAppleResponseError(response.status, bodySnippet(response.body));
  }

  reply.data = data;

  return reply;
}

export function failureTypeOf(reply: DownloadReply): string {
  return String(reply.data?.failureType ?? "");
}

export function customerMessageOf(reply: DownloadReply): string {
  return String(reply.data?.customerMessage ?? "");
}

export function itemsOf(reply: DownloadReply): Record<string, any>[] {
  const items = reply.data?.songList;
  return Array.isArray(items) ? (items as Record<string, any>[]) : [];
}

/**
 * Apple's version identifiers from a reply, newest first (Apple returns oldest
 * first); the reversal happens here so the version pickers can render in order.
 */
export function versionIdentifiersFromReply(reply: DownloadReply): string[] {
  const metadata = itemsOf(reply)[0]?.metadata as Record<string, any> | undefined;
  const rawIdentifiers = metadata?.softwareVersionExternalIdentifiers;

  if (!Array.isArray(rawIdentifiers)) {
    throw new DownloadError(i18n.t("errors.versions.missingIdentifiers"));
  }

  return [...rawIdentifiers].map((value) => String(value)).reverse();
}

/**
 * HTTP 200 with no failureType, no message and no items: the endpoint accepted
 * the request but serves no download for it.
 */
export function isEmptyDownloadResponse(reply: DownloadReply): boolean {
  return (
    reply.status === 200 &&
    failureTypeOf(reply) === "" &&
    customerMessageOf(reply) === "" &&
    itemsOf(reply).length === 0
  );
}

/**
 * HTTP 200 with no failureType and no items, carrying Apple's availability
 * message: this host cannot serve the app for this account.
 */
export function isUnavailableDownloadResponse(reply: DownloadReply): boolean {
  if (reply.status !== 200 || failureTypeOf(reply) !== "" || itemsOf(reply).length !== 0) {
    return false;
  }

  const message = customerMessageOf(reply).trim().toLowerCase();

  return message === "no longer available" || message.endsWith(" no longer available");
}

/** redownload answering HTTP 500 with an empty body: the updateProduct trigger. */
function isEmptyRedownloadError(error: unknown): boolean {
  return (
    error instanceof UnexpectedAppleResponseError &&
    error.status === 500 &&
    error.snippet === ""
  );
}

/**
 * Resolves the newest external version id redownload/updateProduct need; failure
 * is fatal here (as in ipatool) since an unpinned redownload can return a tvOS
 * build indistinguishable from the request. Delisted apps fall back to a recorded pin.
 */
async function pinnedLatestVersionId(session: DownloadSession): Promise<string> {
  const country = storeIdToCountry(session.account.store) ?? "us";
  const platform = session.app.platform;

  const versionId = await withRecordedFallback(
    () =>
      platform === "macos"
        ? lookupLatestMacOSVersionId(
            session.app.id,
            country,
            session.app.bundleID || undefined,
            session.cookies,
          )
        : lookupLatestExternalVersionId(
            session.app.id,
            country,
            platform,
            session.cookies,
          ),
    session.app.id,
    platform,
  );

  if (!versionId) {
    // No catalogue offer and no recorded pin names this platform, but a
    // `local`/`bare` record is a real app, so guess a neighbour id from the iOS
    // list (as `listVersions` does) — else a delisted tvOS/visionOS/macOS direct
    // download fails where 「选择版本」 succeeds.
    if (needsVersionExchange(session.app)) {
      // Dynamic import breaks the cycle (`versionPinGuess` imports this module) and
      // keeps the test mock that intercepts the guess's probes working.
      const { guessPlatformPinFromIOSList } = await import("./versionPinGuess");
      const guessed = await guessPlatformPinFromIOSList(session);
      if (guessed) {
        console.info(
          `[download] guessed a ${platform} pin for ${session.app.id}: ${guessed}`,
        );
        return guessed;
      }
    }

    // No catalogue, recorded pin or neighbour guess has a version id: not proof
    // of a missing app (see `appPresenceFromProbeError`), but no build to download.
    throw new PlatformVersionUnavailableError(
      i18n.t("errors.download.missingVersion"),
    );
  }

  console.info(
    `[download] pinned external version id ${versionId} for ${session.app.id}`,
  );

  return versionId;
}


function dispatchEndpoint(
  bagURL: string,
  expectedPath: string,
  deviceId: string,
): StoreDownloadEndpoint {
  const endpoint = downloadDispatchEndpoint(bagURL, expectedPath, deviceId);

  if (!endpoint) {
    throw new DownloadError(
      `${i18n.t("errors.download.invalidEndpoint")}: ${bagURL}`,
    );
  }

  return endpoint;
}

/**
 * Strips the account's `passwordToken` (a plist `<key>passwordToken</key><string>`
 * value) from an Apple reply before it reaches a console log or error toast.
 */
export function redactAppleSecrets(text: string): string {
  return text.replace(
    /(<key>passwordToken<\/key>\s*<string>)[^<]*(<\/string>)/gi,
    "$1[redacted]$2",
  );
}

/**
 * Single-line excerpt of a response body: credentials redacted, HTML markup
 * stripped. Mirrors ipatool's `bodySnippet`.
 */
export function bodySnippet(body: string, maxLength = 200): string {
  const snippet = redactAppleSecrets(body)
    .replace(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

  return snippet.length > maxLength
    ? `${snippet.slice(0, maxLength)}…`
    : snippet;
}
