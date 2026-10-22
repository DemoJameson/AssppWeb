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
  ENT_DOWNLOAD_PATH,
  REDOWNLOAD_PRODUCT_PATH,
  UPDATE_PRODUCT_PATH,
  downloadDispatchEndpoint,
  isAppleHost,
  storeIdToCountry,
  volumeStoreEndpoint,
  type StoreDownloadEndpoint,
} from "./config";
import {
  acceptDownloadKBSync,
  generateDownloadKBSync,
  invalidateDownloadKBSync,
} from "./sap/client";
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

export interface DownloadRequestOptions {
  /**
   * Skip the preferred ent/download endpoint. Version-pin guessing probes use
   * this so an unpinned probe cannot recursively ask for another pin.
   */
  legacyOnly?: boolean;
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
 * Apple now points the bag's volumeStoreDownloadProduct key at ent/download,
 * which requires a StoreAgent-generated kbsync. Prefer it when a pin is known;
 * an unpinned iOS request first resolves the current build. Any failure that
 * says nothing definitive about the app/version falls through to the legacy
 * volumeStore -> redownload -> updateProduct chain.
 */
export async function requestDownloadProduct(
  session: DownloadSession,
  pinnedVersionId: string,
  options: DownloadRequestOptions = {},
): Promise<DownloadReply> {
  const { account } = session;
  const guid = account.deviceIdentifier;

  let externalVersionId = pinnedVersionId;
  let entDownloadFailure: DownloadError | null = null;

  // volumeStore answers by the account's device class (iOS by default), not the
  // requested platform: an unpinned tvOS/watchOS/visionOS request can return
  // the iOS ipa, so pin that platform's version first. macOS pins its Mac offer
  // from the storefront before the preferred request too.
  if (!externalVersionId && needsPlatformPin(session.app.platform)) {
    externalVersionId = await pinnedLatestVersionId(session, {
      allowGuess: !options.legacyOnly,
    });
  }

  // fetchBag already degrades to the default auth URL on failure; a thrown
  // error here means its mocked/transport contract changed, so leave the bag
  // unset and let the legacy chain make its own attempt.
  let bag: Awaited<ReturnType<typeof fetchBag>> | null = options.legacyOnly
    ? null
    : await fetchBag(guid).catch(() => null);

  if (bag?.entDownloadEndpoint) {
    let preferredVersionId = externalVersionId;
    if (!preferredVersionId) {
      try {
        preferredVersionId = await pinnedLatestVersionId(session, {
          allowGuess: !options.legacyOnly,
        });
      } catch {
        // Preserve the legacy volumeStore path when the catalogue cannot pin.
      }
    }

    if (preferredVersionId) {
      try {
        const endpoint = dispatchEndpoint(
          bag.entDownloadEndpoint,
          ENT_DOWNLOAD_PATH,
          guid,
        );
        return await sendEntDownload(session, endpoint, preferredVersionId);
      } catch (error) {
        if (error instanceof DownloadError) entDownloadFailure = error;
        // Match ipatool: generation, transport, endpoint validation and reply
        // shape failures all fall through to the legacy chain. A structured
        // Apple failure is returned by that chain as the real answer.
        console.warn(
          `[download] ent/download unavailable, trying legacy endpoints: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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

  bag ??= await fetchBag(guid);
  // Nothing advertised to fall back to: report what volumeStore said — or, when
  // it never got through, the transport failure itself.
  if (!bag.redownloadEndpoint) {
    if (volumeStoreReply) return volumeStoreReply;
    throw entDownloadFailure ?? volumeStoreFailure;
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
      externalVersionId = await pinnedLatestVersionId(session, {
        allowGuess: !options.legacyOnly,
      });
    } catch (error) {
      // Reached only while recovering: if volumeStore never answered, the pin
      // lookup fails for the same reason, so report that real failure instead of
      // "no build for this platform" (the empty-reply path keeps the lookup's answer).
      throw entDownloadFailure ?? volumeStoreFailure ?? error;
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
 * The kbsync-backed endpoint. It deliberately does not follow redirects: the
 * request carries X-Token, which must only reach the exact Apple host the bag
 * advertised.
 */
async function sendEntDownload(
  session: DownloadSession,
  endpoint: StoreDownloadEndpoint,
  externalVersionId: string,
): Promise<DownloadReply> {
  const { account, app } = session;
  const hardwareId = hexBytes(account.deviceIdentifier);
  if (!hardwareId || hardwareId.length !== 6) {
    throw new DownloadError("ent/download requires a six-byte device GUID");
  }

  // Mirrors ipatool's StoreAgent serialNumber derivation.
  const serial = new Uint8Array(9);
  serial.set([0x54, 0xc8, 0xb0, 0xa9, 0x88]);
  serial.set(hardwareId.subarray(2), 5);
  const serialNumber = bytesToBase64(serial);

  let kbsync = await generateDownloadKBSync(
    account.deviceIdentifier,
    account.directoryServicesIdentifier,
  );
  let freshBlobRetried = false;

  while (true) {
    try {
      const response = await appleRequest({
        method: "POST",
        host: endpoint.host,
        path: endpoint.path,
        headers: {
          // ipatool mirrors Store's XMLPayload here: the header is the
          // framework's form type even though the bytes are a plist.
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "User-Agent":
            "Configurator/2.18 (Macintosh; OS X 15.3.2; 24D81) AppleWebKit/0620.2.4.11.6",
          "X-Apple-Store-Front": account.store,
          "X-Token": account.passwordToken,
          "iCloud-DSID": account.directoryServicesIdentifier,
          "X-Dsid": account.directoryServicesIdentifier,
        },
        body: buildPlist({
          creditDisplay: "",
          guid: account.deviceIdentifier,
          kbsync: kbsync.blob,
          salableAdamId: String(app.id),
          serialNumber,
          externalVersionId,
        }),
        cookies: session.cookies,
      });

      session.cookies = extractAndMergeCookies(response.rawHeaders, session.cookies);
      const reply = toReply(response, endpoint);

      // A structured failure is Apple's answer about the account or app, not
      // evidence that the kbsync blob is stale. Leave ent/download and let the
      // legacy chain surface that answer without speculatively rebuilding the
      // StoreAgent session.
      if (failureTypeOf(reply) !== "" || customerMessageOf(reply) !== "") {
        throw new DownloadError(
          customerMessageOf(reply) ||
            i18n.t("errors.download.downloadFailed", {
              failureType: failureTypeOf(reply),
            }),
          failureTypeOf(reply) || undefined,
        );
      }

      // Any other reply that is not the requested download is this endpoint
      // refusing the attempt. ipatool treats it as an ent/download miss and
      // falls through to the legacy chain. An UnexpectedAppleResponseError lets
      // the catch below retry a cached blob once; a fresh blob is not retried.
      if (
        reply.status !== 200 ||
        !entDownloadReplyMatches(reply, session.app, externalVersionId)
      ) {
        invalidateDownloadKBSync(
          account.deviceIdentifier,
          account.directoryServicesIdentifier,
          kbsync.blob,
        );
        throw new UnexpectedAppleResponseError(
          reply.status,
          bodySnippet(reply.body),
        );
      }

      // Only a blob Apple accepted is reused; a generated but rejected blob must
      // be regenerated on the next attempt.
      acceptDownloadKBSync(
        account.deviceIdentifier,
        account.directoryServicesIdentifier,
        kbsync.blob,
      );
      return reply;
    } catch (error) {
      if (!(error instanceof UnexpectedAppleResponseError)) throw error;

      invalidateDownloadKBSync(
        account.deviceIdentifier,
        account.directoryServicesIdentifier,
        kbsync.blob,
      );

      // ipatool retries a rejected cached blob once with a fresh one; a rejected
      // fresh blob is not retried, since another generation cannot be trusted to
      // differ. Cancellation and other callers' newer cache entries are left alone.
      if (!kbsync.fromAcceptedCache || freshBlobRetried) throw error;
      freshBlobRetried = true;
      kbsync = await generateDownloadKBSync(
        account.deviceIdentifier,
        account.directoryServicesIdentifier,
      );
    }
  }
}

/** Whether an ent/download reply names exactly the requested downloadable build. */
function entDownloadReplyMatches(
  reply: DownloadReply,
  app: Software,
  externalVersionId: string,
): boolean {
  const items = itemsOf(reply);
  const metadata = (items[0]?.metadata ?? {}) as Record<string, any>;
  const bundleId = metadata.softwareVersionBundleId;

  return (
    items.length === 1 &&
    String(metadata.itemId) === String(app.id) &&
    String(metadata.softwareVersionExternalIdentifier) === externalVersionId &&
    typeof bundleId === "string" &&
    bundleId !== "" &&
    (!app.bundleID || bundleId === app.bundleID) &&
    typeof items[0].URL === "string" &&
    items[0].URL !== ""
  );
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^([0-9a-fA-F]{2})+$/.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
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
async function pinnedLatestVersionId(
  session: DownloadSession,
  options: { allowGuess?: boolean } = {},
): Promise<string> {
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
            session.app.bundleID || undefined,
          ),
    session.app.id,
    platform,
  );

  if (!versionId) {
    // No catalogue offer and no recorded pin names this platform, but a
    // `local`/`bare` record is a real app, so guess a neighbour id from the iOS
    // list (as `listVersions` does) — else a delisted tvOS/watchOS/visionOS/macOS direct
    // download fails where 「选择版本」 succeeds.
    if (options.allowGuess !== false && needsVersionExchange(session.app)) {
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
