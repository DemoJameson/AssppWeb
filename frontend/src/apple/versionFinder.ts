import type { Account, Software } from "../types";
import {
  FAILURE_LICENSE_NOT_FOUND,
  FAILURE_PASSWORD_TOKEN_EXPIRED,
  FAILURE_SIGN_IN_REQUIRED,
  storeIdToCountry,
} from "./config";
import {
  DownloadError,
  MissingAppError,
  PlatformVersionUnavailableError,
} from "./errors";
import {
  createDownloadSession,
  customerMessageOf,
  failureTypeOf,
  itemsOf,
  requestDownloadProduct,
  versionIdentifiersFromReply,
  type DownloadReply,
} from "./downloadProduct";
import { guessPlatformPinFromIOSList } from "./versionPinGuess";
import {
  lookupLatestExternalVersionId,
  lookupLatestMacOSVersionId,
} from "./platformVersion";
import { withRecordedFallback } from "./versionPins";
import { needsPlatformPin } from "./platform";
import { needsVersionExchange } from "../utils/software";
import i18n from "../i18n";

export interface VersionListOutput {
  /**
   * External version identifiers, newest first. Apple returns them oldest
   * first; the version pickers (ProductDetail, PackageDetail)
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
 *
 * A caller-provided version id pins the exchange directly, skipping the
 * platform lookup — the path that reaches a delisted app's version list.
 */
export async function listVersions(
  account: Account,
  app: Software,
  pinnedVersionId?: string,
): Promise<VersionListOutput & { updatedCookies: typeof account.cookies }> {
  const session = createDownloadSession(account, app);

  // ipatool's ListVersions pins macOS/tvOS/visionOS before the exchange so the
  // version list reflects the requested platform, not the account's default
  // device class (iOS). iOS/iPad pass an empty pin and let the exchange resolve
  // one itself when it falls back.
  const requestedPin = pinnedVersionId?.trim();
  const pin = requestedPin ? requestedPin : await platformVersionPin(session);

  const reply = await requestDownloadProduct(session, pin);

  assertListVersionsReply(reply);

  const metadata = itemsOf(reply)[0].metadata as Record<string, any> | undefined;
  const latest = metadata?.softwareVersionExternalIdentifier;

  return {
    versions: versionIdentifiersFromReply(reply),
    // Unlike ipatool, a missing "latest" pointer is not an error here: this app
    // offers "latest" as an explicit choice rather than reading it off the reply.
    latestExternalVersionId: latest === undefined || latest === null ? undefined : String(latest),
    updatedCookies: session.cookies,
  };
}

/**

 * Resolves the platform-specific version pin for the version list exchange.
 * Mirrors ipatool's `ListVersions`: macOS/tvOS/visionOS pin before the
 * exchange so the listed versions belong to the requested platform; iOS/iPad
 * pass an empty pin and let the exchange resolve one on fallback.
 *
 * When the catalogue cannot name a version — a delisted app is the case this
 * exists for — the pin recorded from a previous download is used instead.
 */
async function platformVersionPin(
  session: ReturnType<typeof createDownloadSession>,
): Promise<string> {
  const platform = session.app.platform;
  if (!needsPlatformPin(platform)) {
    return "";
  }

  const country = storeIdToCountry(session.account.store) ?? "us";
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
    // past download recorded a version id *for it*. That is not the same as
    // knowing nothing about the app — a `local` record is a compiled package
    // from some other platform (an iOS build, typically), so the app is real
    // while this platform's build is still unknown.
    //
    // Either way the iOS version list answers the open question: a release's
    // builds share adjacent ids across platforms, though an id the iOS list
    // itself carries never is one of them. Only a storefront record — whose
    // platform offers Apple already enumerated — has nothing to guess.
    if (needsVersionExchange(session.app)) {
      const guessed = await guessPlatformPinFromIOSList(session);
      if (guessed) {
        console.info(
          `[versions] guessed a ${platform} pin for ${session.app.id}: ${guessed}`,
        );
        return guessed;
      }
    }

    // Nothing could name a build for this platform. That is not proof of a
    // missing app — a known version id can still serve a delisted app — but it
    // does settle the platform: there is nothing here to fetch.
    throw new PlatformVersionUnavailableError(
      i18n.t("errors.download.missingVersion"),
    );
  }

  return versionId;
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
    // Apple's own wording without a failure type and without a product is its
    // absence signal ("… No Longer Available"); with a failure type it is a real
    // answer about a real request, so only the former counts as a missing app.
    if (failureType === "") throw new MissingAppError(customerMessage);
    throw new DownloadError(customerMessage, failureType);
  }

  if (failureType !== "") {
    throw new DownloadError(
      i18n.t("errors.versions.failed", { failureType }),
      failureType,
    );
  }

  if (items.length === 0) {
    // No message, no failure type and no item: Apple answered the exchange
    // without anything to serve, which is what an id it does not know gets.
    throw new MissingAppError(i18n.t("errors.versions.missingMetadata"));
  }
}
