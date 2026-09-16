import type { Account, Software } from "../types";
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

export interface VersionListOutput {
  /**
   * External version identifiers, newest first. Apple returns them oldest
   * first; the version pickers (AddDownload, PackageDetail, VersionHistory)
   * render the array in order, so the reversal happens here rather than in
   * each caller.
   */
  versions: string[];
  /** Apple's own pointer to the newest version, as ipatool reports it. */
  latestExternalVersionId?: string;
}

/**
 * Lists the versions an account can download, mirroring ipatool's `ListVersions`
 * (pkg/appstore/appstore_list_versions.go). It drives the same
 * download-product exchange the download flow uses, which is what makes the
 * endpoint fallbacks apply here too.
 */
export async function listVersions(
  account: Account,
  app: Software,
): Promise<VersionListOutput & { updatedCookies: typeof account.cookies }> {
  const session = createDownloadSession(account, app);

  // An empty pin: for iPhone the exchange resolves one itself when it falls back.
  const reply = await requestDownloadProduct(session, "");

  assertListVersionsReply(reply);

  const metadata = itemsOf(reply)[0].metadata as Record<string, any> | undefined;
  const rawIdentifiers = metadata?.softwareVersionExternalIdentifiers;

  if (!Array.isArray(rawIdentifiers)) {
    throw new DownloadError(i18n.t("errors.versions.missingIdentifiers"));
  }

  const identifiers = rawIdentifiers.map((value) => String(value));
  const latest = metadata?.softwareVersionExternalIdentifier;

  return {
    versions: [...identifiers].reverse(),
    // Unlike ipatool, a missing "latest" pointer is not an error here: this app
    // offers "latest" as an explicit choice rather than reading it off the reply.
    latestExternalVersionId: latest === undefined || latest === null ? undefined : String(latest),
    updatedCookies: session.cookies,
  };
}

/**
 * Failure mapping of ipatool's `ListVersions`. It differs from the download
 * flow's: only the token failures and a missing license are classified, and
 * `5002` is reported as a plain failure rather than as a session problem.
 */
function assertListVersionsReply(reply: DownloadReply): void {
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
