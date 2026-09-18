// The shared download-product exchange, mirroring ipatool's
// `sendDownloadProduct` (pkg/appstore/appstore_download_product.go).
//
// ipatool drives three different appstore operations through this one function —
// Download, ListVersions and GetVersionMetadata — so it lives here rather than
// inside the download flow. Callers supply a pin (or an empty string) and then
// apply their own failure mapping to the reply.

import type { Account, Software, Cookie, Platform } from "../types";
import { appleRequest, type AppleRequestOptions, type AppleResponse } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag } from "./bag";
import {
  lookupLatestExternalVersionId,
  lookupLatestMacOSVersionId,
} from "./platformVersion";
import { withRecordedFallback } from "./versionPins";
import {
  REDOWNLOAD_PRODUCT_PATH,
  UPDATE_PRODUCT_PATH,
  downloadDispatchEndpoint,
  storeIdToCountry,
  volumeStoreEndpoint,
  type StoreDownloadEndpoint,
} from "./config";
import i18n from "../i18n";

/** Apple's own cap on the number of redirects it will route a download through. */
const MAX_REDIRECTS = 10;

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/**
 * Apple answered with something that is not a plist — an HTML error page, or a
 * status with nothing in it. Mirrors ipatool's `UnexpectedResponseError`; the
 * `snippet` is what the redownload recovery path inspects to tell an empty HTTP
 * 500 apart from a real failure.
 */
export class UnexpectedAppleResponseError extends Error {
  constructor(
    readonly status: number,
    readonly snippet: string,
  ) {
    super(
      `unexpected response from Apple (HTTP ${status}): ${
        snippet || "empty or non-plist body"
      }`,
    );
    this.name = "UnexpectedAppleResponseError";
  }
}

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
 * volumeStore is the primary endpoint, and it is not the only one: it answers
 * without a download item for apps the account does not own yet (it fulfils the
 * order and replies with the purchase receipt) and can report an app as
 * unavailable. The bag then advertises a redownload endpoint for exactly that
 * case, and when redownload itself cannot serve the request — an empty HTTP 500,
 * or the same availability message — the bag's updateProduct endpoint is the
 * last resort, since it can serve pinned versions.
 *
 * Only those two shapes trigger a fallback. A reply carrying a failureType or a
 * message is a real answer, so it is returned as-is and never mistaken for
 * "try another host".
 */
export async function requestDownloadProduct(
  session: DownloadSession,
  pinnedVersionId: string,
): Promise<DownloadReply> {
  const { account } = session;
  const guid = account.deviceIdentifier;

  let externalVersionId = pinnedVersionId;

  // The volumeStore reply follows the account's device class (iOS by default),
  // not the requested platform: an unpinned request for a tvOS or visionOS
  // build comes back as the iOS ipa. Pin the platform's version first so the
  // request names the build we actually want. macOS apps ship under their own
  // adam ids and need no pin; iOS/iPad keep the historical path.
  if (!externalVersionId && needsPlatformPin(session.app.platform)) {
    externalVersionId = await pinnedLatestVersionId(session);
  }

  const volumeStoreReply = await sendDownloadRequest(
    session,
    volumeStoreEndpoint(account.pod, guid),
    externalVersionId,
  );

  if (
    !isEmptyDownloadResponse(volumeStoreReply) &&
    !isUnavailableDownloadResponse(volumeStoreReply)
  ) {
    return volumeStoreReply;
  }

  const bag = await fetchBag(guid);
  // Nothing advertised to fall back to: report what volumeStore said.
  if (!bag.redownloadEndpoint) {
    return volumeStoreReply;
  }

  const redownload = dispatchEndpoint(
    bag.redownloadEndpoint,
    REDOWNLOAD_PRODUCT_PATH,
    guid,
  );

  // "Unpinned redownloads can fail or return a tvOS package. Select the current
  // iOS build before sending." The reply that would normally carry the version
  // id — the volumeStore document — is the very thing that came back empty.
  if (!externalVersionId) {
    externalVersionId = await pinnedLatestVersionId(session);
  }

  let redownloadReply: DownloadReply;
  try {
    redownloadReply = await sendDownloadRequest(
      session,
      redownload,
      externalVersionId,
    );
  } catch (error) {
    if (bag.updateEndpoint && externalVersionId && isEmptyRedownloadError(error)) {
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
 * The bag's updateProduct endpoint serves pinned versions when redownload comes
 * up empty. Its reply is validated before it is trusted: ipatool requires
 * exactly one item, for the requested app, version and bundle id.
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
 * Apple routes downloads through per-pod hosts and answers the first request
 * with a redirect. The original POST is replayed at the advertised location:
 * the volumeStore hop is a pod hand-off that expects the same body, and Go's
 * client (which ipatool uses) would otherwise downgrade 302 to a bodyless GET.
 * A redirect without a Location is returned untouched, matching ipatool.
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

  // A 3xx that survived the redirect following has no Location: ipatool returns
  // it without a payload rather than failing, so the caller reports it.
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
 * Whether the download exchange must pin a platform-specific version before
 * the first request. tvOS and visionOS builds share an adam id with the iOS
 * app, so an unpinned volumeStore request returns the iOS ipa. macOS apps can
 * share an adam id with the iOS app too, and the legacy MDM lookup returns an
 * iOS offer even with platform=osx, so the Mac storefront page selects the
 * native Mac offer. iOS/iPad are the default device class and need no pin.
 */
function needsPlatformPin(platform?: Platform): boolean {
  return platform === "tvos" || platform === "visionos" || platform === "macos";
}

/**
 * Resolves the newest external version id that redownload and updateProduct
 * need. A failure is fatal here, as in ipatool: an unpinned redownload can
 * return a tvOS build for a universal app, and the rest of the flow has no way
 * to tell that apart from the requested download.
 *
 * When the catalogue cannot name one — delisted apps — the pin recorded from
 * a previous download of the same app+platform is used instead.
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
    throw new DownloadError(i18n.t("errors.download.missingVersion"));
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
 * Compact single-line excerpt of a response body, with HTML markup stripped so
 * the underlying message stays readable. Mirrors ipatool's `bodySnippet`.
 */
export function bodySnippet(body: string, maxLength = 200): string {
  const snippet = body
    .replace(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

  return snippet.length > maxLength
    ? `${snippet.slice(0, maxLength)}…`
    : snippet;
}
