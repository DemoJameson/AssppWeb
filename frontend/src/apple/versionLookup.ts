import type { Account, Software, VersionMetadata } from "../types";
import {
  FAILURE_LICENSE_NOT_FOUND,
  FAILURE_PASSWORD_TOKEN_EXPIRED,
  FAILURE_SIGN_IN_REQUIRED,
} from "./config";
import {
  DownloadError,
  createDownloadSession,
  customerMessageOf,
  failureTypeOf,
  itemsOf,
  requestDownloadProduct,
  type DownloadReply,
} from "./downloadProduct";
import i18n from "../i18n";

/**
 * Reads the display version and release date of one version, mirroring ipatool's
 * `GetVersionMetadata` (pkg/appstore/appstore_get_version_metadata.go): the same
 * download-product exchange, pinned to the requested version.
 *
 * One deliberate deviation: ipatool reads the values out of the IPA itself
 * (range requests against the CDN, "the IPA Info.plist is the source of truth")
 * because Apple's reply can carry stale values. Fetching app assets from the
 * browser would mean widening the Wisp host allowlist and duplicating what the
 * backend already downloads, so the reply's metadata is used instead. The caller
 * treats a failure here as non-fatal.
 */
export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: typeof account.cookies;
}> {
  const session = createDownloadSession(account, app);

  const reply = await requestDownloadProduct(session, versionId);

  assertVersionMetadataReply(reply);

  const itemMetadata = itemsOf(reply)[0].metadata as
    | Record<string, any>
    | undefined;
  if (!itemMetadata) {
    throw new DownloadError(i18n.t("errors.versions.missingMetadata"));
  }

  const displayVersion = itemMetadata.bundleShortVersionString as string;
  if (!displayVersion) {
    throw new DownloadError(i18n.t("errors.versions.missingMetadata"));
  }

  const rawReleaseDate = itemMetadata.releaseDate;
  if (!rawReleaseDate) {
    throw new DownloadError(i18n.t("errors.versions.missingMetadata"));
  }

  const releaseDate =
    rawReleaseDate instanceof Date
      ? rawReleaseDate.toISOString()
      : String(rawReleaseDate);

  return {
    metadata: { displayVersion, releaseDate },
    updatedCookies: session.cookies,
  };
}

/** Failure mapping of ipatool's `GetVersionMetadata`. */
function assertVersionMetadataReply(reply: DownloadReply): void {
  const failureType = failureTypeOf(reply);
  const customerMessage = customerMessageOf(reply);
  const items = itemsOf(reply);

  if (
    failureType === FAILURE_PASSWORD_TOKEN_EXPIRED ||
    failureType === FAILURE_SIGN_IN_REQUIRED
  ) {
    throw new DownloadError(i18n.t("errors.versions.passwordExpired"), failureType);
  }

  if (failureType === FAILURE_LICENSE_NOT_FOUND) {
    throw new DownloadError(i18n.t("errors.versions.licenseRequired"), failureType);
  }

  if (customerMessage !== "" && (failureType !== "" || items.length === 0)) {
    throw new DownloadError(customerMessage, failureType || undefined);
  }

  if (failureType !== "") {
    throw new DownloadError(
      i18n.t("errors.versions.failed", { failureType }),
      failureType,
    );
  }

  if (items.length === 0) {
    throw new DownloadError(i18n.t("errors.versions.missingMetadata"));
  }
}
