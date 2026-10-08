import type { Account, Software, DownloadOutput, Sinf, Cookie } from "../types";
import { buildPlist } from "./plist";
import {
  FAILURE_DEVICE_VERIFICATION_FAILED,
  FAILURE_LICENSE_ALREADY_EXISTS,
  FAILURE_LICENSE_NOT_FOUND,
  FAILURE_PASSWORD_TOKEN_EXPIRED,
  FAILURE_SIGN_IN_REQUIRED,
} from "./config";
import {
  DownloadError,
  bodySnippet,
  createDownloadSession,
  customerMessageOf,
  failureTypeOf,
  itemsOf,
  redactAppleSecrets,
  requestDownloadProduct,
  type DownloadReply,
  type DownloadSession,
} from "./downloadProduct";
import i18n from "../i18n";

export { DownloadError };

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{ output: DownloadOutput; updatedCookies: typeof account.cookies }> {
  const session = createDownloadSession(account, app);

  const reply = await requestDownloadProduct(session, externalVersionId ?? "");

  return interpretReply(session, reply);
}

/**
 * Failure handling of the resolved reply, mirroring ipatool's `Download`. Order
 * matters: session-level failure type, then Apple's message, then the raw failure
 * type. `5002` counts as a password-token failure (a real answer, not "try another host").
 */
function assertDownloadReply(reply: DownloadReply): void {
  const failureType = failureTypeOf(reply);
  const customerMessage = customerMessageOf(reply);
  const items = itemsOf(reply);

  if (
    failureType === FAILURE_PASSWORD_TOKEN_EXPIRED ||
    failureType === FAILURE_SIGN_IN_REQUIRED ||
    failureType === FAILURE_DEVICE_VERIFICATION_FAILED ||
    failureType === FAILURE_LICENSE_ALREADY_EXISTS
  ) {
    throw new DownloadError(i18n.t("errors.download.passwordExpired"), failureType);
  }

  if (failureType === FAILURE_LICENSE_NOT_FOUND) {
    throw new DownloadError(i18n.t("errors.download.licenseRequired"), failureType);
  }

  if (customerMessage !== "" && (failureType !== "" || items.length === 0)) {
    throw new DownloadError(customerMessage, failureType || undefined);
  }

  if (failureType !== "") {
    throw new DownloadError(
      i18n.t("errors.download.downloadFailed", { failureType }),
      failureType,
    );
  }

  if (items.length === 0) {
    throw new DownloadError(unexpectedReply(reply));
  }
}

async function interpretReply(
  session: DownloadSession,
  reply: DownloadReply,
): Promise<{ output: DownloadOutput; updatedCookies: Cookie[] }> {
  assertDownloadReply(reply);

  const item = itemsOf(reply)[0];

  const url = item.URL as string | undefined;
  if (!url) {
    throw new DownloadError(i18n.t("errors.download.missingUrl"));
  }

  // A macOS package is never what another platform asked for, and the pin may have
  // been guessed (see `versionFinder`), so refusing a `.pkg` keeps a tvOS/visionOS/iOS
  // request from an IPA-incompatible download (the backend repeats this check).
  if (
    session.app.platform !== "macos" &&
    /\.pkg$/i.test(url.split(/[?#]/)[0])
  ) {
    throw new DownloadError(i18n.t("errors.download.macOSPackage"));
  }

  const metadata = item.metadata as Record<string, any> | undefined;
  if (!metadata) {
    throw new DownloadError(i18n.t("errors.download.missingMetadata"));
  }

  const version = metadata.bundleShortVersionString as string;
  const bundleVersion = metadata.bundleVersion as string;
  if (!version || !bundleVersion) {
    throw new DownloadError(i18n.t("errors.download.missingVersion"));
  }

  const sinfs: Sinf[] = [];
  // A macOS download is decrypted, so Apple sends key material (dpInfo) instead of
  // a sinf to replicate. Conflicting dpInfo values would mean the reply describes
  // two builds, neither trusted to decrypt the arriving package; ipatool refuses that too.
  let dpInfo: string | undefined;
  const sinfData = item.sinfs as Record<string, any>[] | undefined;
  if (sinfData) {
    for (const sinfItem of sinfData) {
      const id = sinfItem.id as number;
      const sinf = sinfItem.sinf;
      if (id !== undefined && sinf) {
        const sinfBase64 = base64FromField(sinf);
        if (sinfBase64 === undefined) {
          throw new DownloadError(i18n.t("errors.download.invalidSinf"));
        }
        sinfs.push({ id, sinf: sinfBase64 });
      }

      const itemDPInfo = base64FromField(sinfItem.dpInfo);
      if (itemDPInfo !== undefined) {
        if (dpInfo !== undefined && dpInfo !== itemDPInfo) {
          throw new DownloadError(i18n.t("errors.download.conflictingDPInfo"));
        }
        dpInfo = itemDPInfo;
      }
    }
  }

  if (session.app.platform === "macos") {
    // Without dpInfo the delivered package can never be opened, and nothing
    // downstream could do anything but fail — so say so before a task exists.
    if (!dpInfo) {
      throw new DownloadError(i18n.t("errors.download.missingDPInfo"));
    }
  } else if (sinfs.length === 0) {
    throw new DownloadError(i18n.t("errors.download.noSinf"));
  }

  const metadataDict: Record<string, any> = { ...metadata };
  metadataDict["apple-id"] = session.account.email;
  metadataDict["userName"] = session.account.email;
  // The account's password token must never travel inside the IPA.
  delete metadataDict.passwordToken;
  const iTunesMetadata = base64FromString(buildPlist(metadataDict));

  // Apple names the item's bundle id here as well, which is what a by-ID
  // download (no storefront lookup) relies on for its install manifest.
  const bundleID = metadata.softwareVersionBundleId;

  // The id of the build Apple actually served (after any catalogue pin) — the
  // backend records it so later version queries can fall back to it.
  const externalVersionId = metadata.softwareVersionExternalIdentifier;

  return {
    output: {
      downloadURL: url,
      sinfs,
      bundleShortVersionString: version,
      bundleVersion,
      bundleID: typeof bundleID === "string" && bundleID !== "" ? bundleID : undefined,
      externalVersionId:
        externalVersionId === undefined || externalVersionId === null
          ? undefined
          : String(externalVersionId),
      dpInfo,
      iTunesMetadata,
    },
    updatedCookies: session.cookies,
  };
}

/**
 * Names the endpoint, status and content type alongside Apple's answer, and logs
 * the whole reply to the console — credentials redacted first.
 */
function unexpectedReply(reply: DownloadReply): string {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(reply.headers)) {
    headers[key] = /password|token|set-cookie/i.test(key) ? "[redacted]" : value;
  }

  console.error("[download] unexpected Apple reply", {
    endpoint: reply.endpoint,
    status: reply.status,
    headers,
    body: redactAppleSecrets(reply.body),
  });

  const where = reply.endpoint.slice(0, 90);
  const type = reply.headers["content-type"] ?? "no content-type";

  return `${i18n.t(
    "errors.download.noItems",
  )} [${where}] [HTTP ${reply.status}] [${type}] ${bodySnippet(reply.body, 120)}`;
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return base64FromBytes(bytes);
}

/**
 * Reads a `<data>` field from the plist parser: bytes (binary plist) or the
 * string Apple already encoded; anything else is undefined for the caller to handle.
 */
function base64FromField(value: unknown): string | undefined {
  if (value instanceof Uint8Array) return base64FromBytes(value);
  if (value instanceof ArrayBuffer) {
    return base64FromBytes(new Uint8Array(value));
  }
  if (typeof value === "string") return value;
  return undefined;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
