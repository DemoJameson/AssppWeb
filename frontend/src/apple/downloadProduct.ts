// The shared download-product exchange, mirroring ipatool's
// `sendDownloadProduct` (pkg/appstore/appstore_download_product.go). It backs
// Download, ListVersions and GetVersionMetadata, so callers supply a pin (or "")
// and apply their own failure mapping to the reply.

import type { Account, Software, Cookie } from "../types";
import { appleRequest, type AppleRequestOptions, type AppleResponse } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, type BagOutput } from "./bag";
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
  FAILURE_LICENSE_NOT_FOUND,
  FAILURE_SIGN_IN_REQUIRED,
  REDOWNLOAD_PRODUCT_PATH,
  UPDATE_PRODUCT_PATH,
  downloadDispatchEndpoint,
  isAppleHost,
  isStoreCommerceHost,
  storeIdToCountry,
  storeUserAgent,
  volumeStoreEndpoint,
  type StoreDownloadEndpoint,
} from "./config";
import {
  acceptDownloadKBSync,
  generateDownloadKBSync,
  invalidateDownloadKBSync,
  type DownloadStageObserver,
} from "./sap/client";
import { sendMachineValidatedRequest } from "./machineValidation";
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
  /** The public bag, retained so machine actions can use its finish URLs. */
  bag?: BagOutput;
}

export interface DownloadRequestOptions {
  /**
   * Skip the preferred ent/download endpoint. Version-pin guessing probes use
   * this so an unpinned probe cannot recursively ask for another pin, and an
   * iOS/iPad record without storefront metadata takes the same path because it
   * has no catalogue pin for ent/download.
   */
  legacyOnly?: boolean;
  /** Optional, user-friendly progress stages for the exchange. */
  onStage?: DownloadStageObserver;
  /**
   * Download replies must carry the material needed to install the package:
   * a non-empty `sinf` on iOS-family builds, or `dpInfo` on macOS. Version
   * listing and metadata lookups only need the item metadata, so they leave
   * this off.
   */
  requireDownloadMaterial?: boolean;
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
 * which requires a StoreAgent-generated kbsync. Every operation that shares
 * this exchange — Download, ListVersions and GetVersionMetadata — prefers it,
 * exactly as ipatool's `sendDownloadProduct` does. An unpinned iOS request
 * first resolves the current build, while a bare iOS/iPad record (no storefront
 * metadata to pin it with) goes directly to the legacy chain. It is only a fast
 * path: any failure falls through to the legacy volumeStore -> redownload ->
 * updateProduct chain, whose reply is the answer (as in ipatool).
 */
export async function requestDownloadProduct(
  session: DownloadSession,
  pinnedVersionId: string,
  options: DownloadRequestOptions = {},
): Promise<DownloadReply> {
  const { account } = session;
  const guid = account.deviceIdentifier;
  // A bare iOS/iPad record has no storefront metadata to ask ent/download
  // with, so take the legacy volumeStore exchange directly. A local record is
  // still asked through the catalogue/recorded pin: if that fails, the ent
  // attempt falls through to the same legacy chain. A caller-provided or
  // package-index pin is enough for ent/download, whose downloaddispatch host
  // is often reachable when the storefront pod is not.
  const hasPinnedVersion = Boolean(pinnedVersionId?.trim());
  const legacyOnly =
    options.legacyOnly ??
    (session.app.platform !== undefined &&
      (session.app.platform === "ios" || session.app.platform === "ipad") &&
      session.app.metadataSource === "bare" &&
      !hasPinnedVersion);

  let externalVersionId = pinnedVersionId;
  // volumeStore answers by the account's device class (iOS by default), not the
  // requested platform: an unpinned tvOS/watchOS/visionOS request can return
  // the iOS ipa, so pin that platform's version first. macOS pins its Mac offer
  // from the storefront before the preferred request too.
  if (!externalVersionId && needsPlatformPin(session.app.platform)) {
    externalVersionId = await pinnedLatestVersionId(session, {
      allowGuess: !legacyOnly,
    });
  }

  // fetchBag already degrades to the default auth URL on failure; a thrown
  // error here means its mocked/transport contract changed, so leave the bag
  // unset and let the legacy chain make its own attempt.
  let bag: Awaited<ReturnType<typeof fetchBag>> | null = legacyOnly
    ? null
    : await fetchBag(guid).catch(() => null);
  if (bag) session.bag = bag;
  let volumeStoreReply: DownloadReply | null = null;

  if (bag?.entDownloadEndpoint) {
    let preferredVersionId = externalVersionId;
    if (!preferredVersionId) {
      try {
        preferredVersionId = await pinnedLatestVersionId(session, {
          allowGuess: !legacyOnly,
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
        const reply = await sendEntDownload(
          session,
          endpoint,
          preferredVersionId,
          options.onStage,
        );
        if (
          options.requireDownloadMaterial &&
          !hasDownloadMaterial(reply, session.app.platform)
        ) {
          throw new UnexpectedAppleResponseError(reply.status, bodySnippet(reply.body));
        }
        return reply;
      } catch (error) {
        options.onStage?.(null);
        // Match ipatool: generation, transport, endpoint validation and reply
        // shape failures all fall through to the legacy chain, which answers
        // for the app. ent/download is an optional fast path, so its error must
        // not outrank a working legacy download or mask the legacy failure.
        console.warn(
          `[download] ent/download unavailable for ${session.app.id}, trying legacy endpoints: ${
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

  if (volumeStoreReply) {
    const failureType = failureTypeOf(volumeStoreReply);
    const message = customerMessageOf(volumeStoreReply);

    // A reply with a structured failure is Apple's answer, not evidence that this
    // host cannot serve the app. Only the empty/unavailable shapes are endpoint
    // misses; letting a 2034 or 9610 fall through would hide the session or
    // licence signal behind an unrelated fallback error. "No Longer Available"
    // is the one message-only shape that is an endpoint miss.
    if (
      failureType !== "" ||
      (message !== "" && !isUnavailableDownloadResponse(volumeStoreReply))
    ) {
      return volumeStoreReply;
    }

    const usable =
      !isEmptyDownloadResponse(volumeStoreReply) &&
      !isUnavailableDownloadResponse(volumeStoreReply) &&
      (!options.requireDownloadMaterial ||
        hasDownloadMaterial(volumeStoreReply, session.app.platform));
    if (usable) return volumeStoreReply;
  }

  bag ??= await fetchBag(guid);
  session.bag = bag;
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
      externalVersionId = await pinnedLatestVersionId(session, {
        allowGuess: !legacyOnly,
      });
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
        options.requireDownloadMaterial === true,
      );
    }
    throw error;
  }

  const redownloadUnavailable = isRedownloadUnavailableReply(redownloadReply);
  const redownloadNoLicenceFailure = () =>
    new DownloadError(
      i18n.t("errors.download.licenseRequired"),
      FAILURE_LICENSE_NOT_FOUND,
    );
  const redownloadMissingMaterial =
    options.requireDownloadMaterial &&
    redownloadReply.status === 200 &&
    failureTypeOf(redownloadReply) === "" &&
    !hasDownloadMaterial(redownloadReply, session.app.platform);

  if (
    bag.updateEndpoint &&
    externalVersionId &&
    (isUnavailableDownloadResponse(redownloadReply) ||
      redownloadUnavailable ||
      redownloadMissingMaterial)
  ) {
    try {
      return await sendUpdateProduct(
        session,
        dispatchEndpoint(bag.updateEndpoint, UPDATE_PRODUCT_PATH, guid),
        externalVersionId,
        options.requireDownloadMaterial === true,
      );
    } catch (error) {
      if (redownloadUnavailable) {
        if (isMissingLicenceError(error)) throw error;
        throw redownloadNoLicenceFailure();
      }
      throw error;
    }
  }

  if (redownloadUnavailable) {
    throw redownloadNoLicenceFailure();
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
  onStage?: DownloadStageObserver,
): Promise<DownloadReply> {
  const { account, app } = session;
  const storeFront = account.storeFront || `${account.store}-1`;
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
    onStage,
  );
  // Action responses can carry cookies that the replay needs. Keep them local
  // to the ent attempt so a failed fast path cannot rotate the shared session.
  let requestCookies = [...session.cookies];
  let freshBlobRetried = false;
  let authDialogRetried = false;

  while (true) {
    try {
      onStage?.({ stage: "connecting", percent: null });
      const startedAt = Date.now();
      const response = await sendMachineValidatedRequest({
        deviceIdentifier: account.deviceIdentifier,
        endpoint: `https://${endpoint.host}${endpoint.path}`,
        bag: session.bag,
        headers: {
          // ipatool mirrors Store's XMLPayload here: the header is the
          // framework's form type even though the bytes are a plist.
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "User-Agent": storeUserAgent,
          "X-Apple-Store-Front": storeFront,
          "X-Token": account.passwordToken,
          "iCloud-DSID": account.directoryServicesIdentifier,
          "X-Dsid": account.directoryServicesIdentifier,
        },
        send: (headers) =>
          appleRequest({
            method: "POST",
            host: endpoint.host,
            path: endpoint.path,
            headers,
            body: buildPlist({
              creditDisplay: "",
              guid: account.deviceIdentifier,
              kbsync: kbsync.blob,
              salableAdamId: String(app.id),
              serialNumber,
              externalVersionId,
              ...(authDialogRetried
                ? { hasBeenAuthedForBuy: "true" }
                : {}),
            }),
            cookies: [...requestCookies],
          }),
        onResponse: (response) => {
          requestCookies = extractAndMergeCookies(
            response.rawHeaders,
            requestCookies,
          );
        },
      });

      const reply = toReply(response, endpoint);
      onStage?.({ stage: "confirming", percent: null });
      const failureType = failureTypeOf(reply);
      const customerMessage = customerMessageOf(reply);

      // 2042 AuthTokenResumeFreeBuy is Apple's "click Download in the
      // authorization dialog" step. Replay the same request once with
      // hasBeenAuthedForBuy=true before treating it as a failure.
      if (
        failureType === FAILURE_SIGN_IN_REQUIRED &&
        !authDialogRetried &&
        isAuthorizationDialog(reply)
      ) {
        authDialogRetried = true;
        console.info(
          `[download] ent/download authorization dialog for ${session.app.id}; replaying with hasBeenAuthedForBuy`,
        );
        continue;
      }

      // A structured failure is Apple's answer about the account or app, not
      // evidence that the kbsync blob is stale. Leave ent/download and let the
      // legacy chain surface that answer without speculatively rebuilding the
      // StoreAgent session.
      if (failureType !== "" || customerMessage !== "") {
        throw new DownloadError(
          customerMessage ||
            i18n.t("errors.download.downloadFailed", {
              failureType,
            }),
          failureType || undefined,
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
        await invalidateDownloadKBSync(
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
      await acceptDownloadKBSync(
        account.deviceIdentifier,
        account.directoryServicesIdentifier,
        kbsync.blob,
      );
      // Only an accepted ent/download reply may rotate the shared session. A
      // failed fast path must leave the legacy chain the cookies it started with.
      session.cookies = requestCookies;
      console.info(
        `[download] ent/download served ${session.app.id} in ${Date.now() - startedAt}ms`,
      );
      return reply;
    } catch (error) {
      if (!(error instanceof UnexpectedAppleResponseError)) throw error;

      await invalidateDownloadKBSync(
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
        onStage,
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
  requireDownloadMaterial = false,
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

  if (
    !matchesRequestedApp ||
    (requireDownloadMaterial &&
      !hasDownloadMaterial(reply, session.app.platform))
  ) {
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
  const storeFront = account.storeFront || `${account.store}-1`;

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
      "User-Agent": storeUserAgent,
      "X-Apple-Store-Front": storeFront,
      "X-Token": account.passwordToken,
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
  let headers = { ...(request.headers ?? {}) };

  for (let hop = 0; ; hop++) {
    const response = await sendMachineValidatedRequest({
      deviceIdentifier: session.account.deviceIdentifier,
      endpoint: `https://${host}${path}`,
      bag: session.bag,
      headers,
      send: (finalHeaders) =>
        appleRequest({
          ...request,
          host,
          path,
          headers: finalHeaders,
          cookies: session.cookies,
        }),
      onResponse: (response) => {
        session.cookies = extractAndMergeCookies(
          response.rawHeaders,
          session.cookies,
        );
      },
    });

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
    if (!isStoreCommerceHost(url.hostname)) {
      // X-Token is a password token. Only the commerce hosts Apple uses for
      // this exchange may receive it; a redirect to another Apple service must
      // not carry it along with the body and session cookies.
      headers = stripHeader(headers, "X-Token");
    }
    host = url.hostname;
    path = url.pathname + url.search;
  }
}

function stripHeader(
  headers: Record<string, string>,
  name: string,
): Record<string, string> {
  const out = { ...headers };
  const wanted = name.toLowerCase();
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === wanted) delete out[key];
  }
  return out;
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

/**
 * Apple's failure code, preferring the top-level field and falling back to
 * `metrics.messageCode` only when it carries the 2042 authorization signal
 * (the same fallback ipatool-cpp uses). Other metrics codes are analytics,
 * not failures.
 */
export function failureTypeOf(reply: DownloadReply): string {
  const direct = reply.data?.failureType;
  if (direct !== undefined && direct !== null && String(direct) !== "") {
    return String(direct);
  }

  const metrics = reply.data?.metrics;
  if (metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
    const messageCode = (metrics as Record<string, any>).messageCode;
    if (
      messageCode !== undefined &&
      messageCode !== null &&
      String(messageCode) === FAILURE_SIGN_IN_REQUIRED
    ) {
      return FAILURE_SIGN_IN_REQUIRED;
    }
  }

  return "";
}

export function customerMessageOf(reply: DownloadReply): string {
  return String(reply.data?.customerMessage ?? "");
}

/** Apple's 2042 authorization dialog: the "Download" confirmation step. */
function isAuthorizationDialog(reply: DownloadReply): boolean {
  const dialog = reply.data?.dialog;
  return (
    !!dialog &&
    typeof dialog === "object" &&
    !Array.isArray(dialog) &&
    String((dialog as Record<string, any>).kind ?? "").toLowerCase() ===
      "authorization"
  );
}

export function itemsOf(reply: DownloadReply): Record<string, any>[] {
  const items = reply.data?.songList;
  return Array.isArray(items) ? (items as Record<string, any>[]) : [];
}

/** Whether an item carries the material the download pipeline needs. */
export function hasDownloadMaterial(
  reply: DownloadReply,
  platform: Software["platform"],
): boolean {
  const sinfs = itemsOf(reply)[0]?.sinfs;
  if (!Array.isArray(sinfs)) return false;

  for (const entry of sinfs) {
    if (!entry || typeof entry !== "object") continue;
    const field = platform === "macos" ? entry.dpInfo : entry.sinf;
    if (field instanceof Uint8Array) {
      if (field.byteLength > 0) return true;
    } else if (field instanceof ArrayBuffer) {
      if (field.byteLength > 0) return true;
    } else if (typeof field === "string" && field !== "") {
      return true;
    }
  }
  return false;
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

const REDOWNLOAD_UNAVAILABLE_MESSAGE =
  "Redownload Unavailable with This Apple Account";
const REDOWNLOAD_UNAVAILABLE_EXPLANATION =
  "This redownload is not available for this Apple Account either because it was bought by a different user or the item was refunded or cancelled.";

/** Apple's spaces in these messages include U+00A0 and U+2000–U+200A. */
function normalizeAppleMessage(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u00a0\u2000-\u200a\u202f\s]+/gu, " ")
    .trim();
}

function redownloadUnavailableFields(data: Record<string, any> | null | undefined): boolean {
  if (!data) return false;
  return (
    normalizeAppleMessage(data.message) === REDOWNLOAD_UNAVAILABLE_MESSAGE &&
    normalizeAppleMessage(data.explanation) === REDOWNLOAD_UNAVAILABLE_EXPLANATION
  );
}

/**
 * Apple's 200-level refusal when the account has no licence for the item. The
 * exact pair is matched: a looser "Apple Account" search could turn unrelated
 * refusals into a purchase prompt.
 */
export function isRedownloadUnavailableReply(reply: DownloadReply): boolean {
  if (reply.status === 500 || failureTypeOf(reply) !== "") return false;
  return (
    redownloadUnavailableFields(reply.data) ||
    redownloadUnavailableFields(reply.data?.dialog)
  );
}

function isMissingLicenceError(error: unknown): boolean {
  return (
    error instanceof DownloadError &&
    error.code === FAILURE_LICENSE_NOT_FOUND
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
    // No catalogue offer and no recorded pin names this platform. A
    // `local`/`bare` record is still a real app, so a non-iOS platform may
    // guess a neighbour id from the iOS list (as `listVersions` does) — else a
    // delisted tvOS/watchOS/visionOS/macOS direct download fails where
    // 「选择版本」 succeeds. iOS/iPad are the exception: an unpinned legacy
    // exchange is already the iOS list, and a neighbour there is another
    // platform's build (Forward's 1.3.19 tvOS id was picked this way).
    if (
      options.allowGuess !== false &&
      needsPlatformPin(platform) &&
      needsVersionExchange(session.app)
    ) {
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
