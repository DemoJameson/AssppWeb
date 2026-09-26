// The shared download-product exchange, mirroring ipatool's
// `sendDownloadProduct` (pkg/appstore/appstore_download_product.go).
//
// ipatool drives three different appstore operations through this one function —
// Download, ListVersions and GetVersionMetadata — so it lives here rather than
// inside the download flow. Callers supply a pin (or an empty string) and then
// apply their own failure mapping to the reply.

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
  storeIdToCountry,
  volumeStoreEndpoint,
  type StoreDownloadEndpoint,
} from "./config";
import i18n from "../i18n";

// The error types themselves live in `errors.ts` (importable without the
// libcurl graph); they are re-exported here, the module whose protocol they
// describe, so existing import sites keep working.
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

  // A request Apple never answered says nothing about whether this endpoint
  // could have served the app — and the fallbacks live on another host, so the
  // next one is a real alternative rather than a repeat of the same dead path.
  // (The storefront host's address pool is the one that goes silent; see
  // AGENTS.md.) Everything Apple *answered* stays with the shape checks below,
  // which is where an empty or unavailable reply is decided.
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

  // "Unpinned redownloads can fail or return a tvOS package. Select the current
  // iOS build before sending." The reply that would normally carry the version
  // id — the volumeStore document — is the very thing that came back empty, or
  // never came back at all.
  if (!externalVersionId) {
    try {
      externalVersionId = await pinnedLatestVersionId(session);
    } catch (error) {
      // Reached only because the exchange is already recovering from something:
      // when volumeStore never answered, the pin lookup fails for that same
      // reason, and "this platform has no build" would be a wrong diagnosis of a
      // request that never reached Apple. Report what actually happened; on the
      // empty-reply path there is no such failure to report and the lookup's own
      // answer stands.
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
 * Apple's version identifiers from a download-product reply, newest first. It
 * returns them oldest first; the version pickers (ProductDetail's, and the
 * downloads page's update picker)
 * render the array in order, so the reversal happens here rather than in each
 * caller.
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
    // Nothing can name a build for this platform: no catalogue offer, and no
    // past download recorded a version id *for it*. A `local` or `bare` record
    // is still a real app, so the iOS version list may name a neighbour id the
    // target platform serves — the same guess `listVersions` uses. Without it,
    // a direct download of a delisted app's tvOS/visionOS/macOS build fails
    // where 「选择版本」 succeeds.
    if (needsVersionExchange(session.app)) {
      // Dynamic import breaks the cycle: `versionPinGuess` imports this
      // module's `requestDownloadProduct`, so a static import here would
      // defeat the test mock that intercepts the guess's probes.
      const { guessPlatformPinFromIOSList } = await import("./versionPinGuess");
      const guessed = await guessPlatformPinFromIOSList(session);
      if (guessed) {
        console.info(
          `[download] guessed a ${platform} pin for ${session.app.id}: ${guessed}`,
        );
        return guessed;
      }
    }

    // A pinned version is required here and neither the catalogue, a recorded
    // pin, nor a neighbour guess has one. That is not proof of a missing app
    // (see `appPresenceFromProbeError`), but it does settle the platform:
    // there is no build of it to download.
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
 * Strips the account's `passwordToken` (and anything else keyed `passwordToken`)
 * from an Apple reply before it reaches a console log or an error toast. The
 * download-product reply is a plist; the token rides as the value of a
 * `<key>passwordToken</key><string>…</string>` pair that a snippet would
 * otherwise carry verbatim.
 */
export function redactAppleSecrets(text: string): string {
  return text.replace(
    /(<key>passwordToken<\/key>\s*<string>)[^<]*(<\/string>)/gi,
    "$1[redacted]$2",
  );
}

/**
 * Compact single-line excerpt of a response body, with HTML markup stripped so
 * the underlying message stays readable, and any credentials redacted first.
 * Mirrors ipatool's `bodySnippet`.
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
