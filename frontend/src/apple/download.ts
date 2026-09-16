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
 * Failure handling of the resolved reply, mirroring ipatool's `Download`.
 * Order matters: a session-level failure type is reported before Apple's own
 * message, which in turn is preferred over the raw failure type.
 *
 * `5002` is grouped with the password-token failures here (ipatool's
 * `Download` does the same) — it is a real answer from the endpoint, not a
 * signal to try another host.
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
  const sinfData = item.sinfs as Record<string, any>[] | undefined;
  if (sinfData) {
    for (const sinfItem of sinfData) {
      const id = sinfItem.id as number;
      const sinf = sinfItem.sinf;
      if (id !== undefined && sinf) {
        let sinfBase64: string;
        if (sinf instanceof Uint8Array || sinf instanceof ArrayBuffer) {
          const bytes = sinf instanceof ArrayBuffer ? new Uint8Array(sinf) : sinf;
          sinfBase64 = base64FromBytes(bytes);
        } else if (typeof sinf === "string") {
          sinfBase64 = sinf;
        } else {
          throw new DownloadError(i18n.t("errors.download.invalidSinf"));
        }
        sinfs.push({ id, sinf: sinfBase64 });
      }
    }
  }

  if (sinfs.length === 0) {
    throw new DownloadError(i18n.t("errors.download.noSinf"));
  }

  // Build iTunesMetadata plist
  const metadataDict: Record<string, any> = { ...metadata };
  metadataDict["apple-id"] = session.account.email;
  metadataDict["userName"] = session.account.email;
  // The account's password token must never travel inside the IPA.
  delete metadataDict.passwordToken;
  const iTunesMetadata = base64FromString(buildPlist(metadataDict));

  // Apple names the item's bundle id here as well, which is what a manual
  // download (no storefront lookup) relies on for its install manifest.
  const bundleID = metadata.softwareVersionBundleId;

  return {
    output: {
      downloadURL: url,
      sinfs,
      bundleShortVersionString: version,
      bundleVersion,
      bundleID: typeof bundleID === "string" && bundleID !== "" ? bundleID : undefined,
      iTunesMetadata,
    },
    updatedCookies: session.cookies,
  };
}

/**
 * The reply is the only thing that identifies what happened, so name the
 * endpoint, status and content type alongside Apple's answer, and log the whole
 * response for the console.
 */
function unexpectedReply(reply: DownloadReply): string {
  console.error("[download] unexpected Apple reply", {
    endpoint: reply.endpoint,
    status: reply.status,
    headers: reply.headers,
    body: reply.body,
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

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
