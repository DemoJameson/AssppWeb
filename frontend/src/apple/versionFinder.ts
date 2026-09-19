import type { Account, Software } from "../types";
import {
  FAILURE_LICENSE_NOT_FOUND,
  FAILURE_PASSWORD_TOKEN_EXPIRED,
  FAILURE_SIGN_IN_REQUIRED,
  storeIdToCountry,
} from "./config";
import { DownloadError, MissingAppError } from "./errors";
import {
  createDownloadSession,
  customerMessageOf,
  failureTypeOf,
  itemsOf,
  requestDownloadProduct,
  type DownloadReply,
} from "./downloadProduct";
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
 * Apple's version identifiers from a download-product reply, newest first. It
 * returns them oldest first; the version pickers (ProductDetail, PackageDetail)
 * render the array in order, so the reversal happens here rather than in each
 * caller.
 */
function versionIdentifiersFromReply(reply: DownloadReply): string[] {
  const metadata = itemsOf(reply)[0]?.metadata as Record<string, any> | undefined;
  const rawIdentifiers = metadata?.softwareVersionExternalIdentifiers;

  if (!Array.isArray(rawIdentifiers)) {
    throw new DownloadError(i18n.t("errors.versions.missingIdentifiers"));
  }

  return [...rawIdentifiers].map((value) => String(value)).reverse();
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
    // missing app — a known version id can still serve a delisted app — so
    // this stays open-ended rather than classifying as missing.
    throw new DownloadError(i18n.t("errors.download.missingVersion"));
  }

  return versionId;
}

/** Ceiling on the distance a guessed platform pin may sit from the iOS id. */
const PIN_GUESS_MAX_OFFSET = 6;
/** How many of those probes may run at once. */
const PIN_GUESS_CONCURRENCY = 6;

/**
 * Guesses the target platform's version pin for a delisted app from the newest
 * iOS version id. Apple hands out external version ids per upload and a
 * release's builds go up together, so the tvOS/visionOS/macOS build of the same
 * release carries an id *adjacent* to the iOS one. Neighbours are probed
 * nearest-first (±1, ±2, …) against the target platform's own pinned exchange,
 * `PIN_GUESS_CONCURRENCY` at a time; the first id it serves becomes the pin.
 *
 * The iOS list is also the set of ids that are *known* to be iOS builds, and
 * those are never probed: an id it carries belongs to this app's iOS history,
 * so the target platform either was never offered it or answers for it with
 * Apple's iOS fallback either way — probing one can only waste an exchange.
 * Only ids the list does not mention are eligible.
 *
 * Only failures run long: a hit ends the pass, and a pass that walks
 * `PIN_GUESS_MAX_OFFSET` steps each way without a hit gives up.
 */
async function guessPlatformPinFromIOSList(
  session: ReturnType<typeof createDownloadSession>,
): Promise<string | undefined> {
  let versions: string[];
  try {
    versions = await listIOSVersionIds(session);
  } catch (error) {
    console.warn(
      `[versions] could not list iOS versions to guess a pin for ${session.app.id}`,
      error,
    );
    return undefined;
  }

  const newest = Number(versions[0] ?? "");
  // Version ids are positive integers; anything else cannot be offset into a
  // neighbour of itself.
  if (!Number.isSafeInteger(newest) || newest <= 0) return undefined;

  const candidates = neighbourVersionIds(newest, new Set(versions));
  for (let start = 0; start < candidates.length; start += PIN_GUESS_CONCURRENCY) {
    const batch = candidates.slice(start, start + PIN_GUESS_CONCURRENCY);
    const probed = await Promise.all(
      batch.map(async (candidate) => ({
        candidate,
        serves: await servesPlatformVersion(session, candidate),
      })),
    );
    const hit = probed.find((entry) => entry.serves);
    if (hit) return hit.candidate;
  }

  return undefined;
}

/**
 * The ids adjacent to `base`, nearest first: `base + 1`, `base - 1`, `base + 2`,
 * `base - 2`, … The closest neighbour is the likeliest, and each step outwards
 * is only probed when the nearer ones were not served.
 *
 * `exclude` holds the ids the iOS list already contains — and it holds `base`
 * itself, since `base` is the newest of them. An id in that set is a build of
 * this app for iOS, so it is never a candidate here.
 */
function neighbourVersionIds(
  base: number,
  exclude: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (let offset = 1; offset <= PIN_GUESS_MAX_OFFSET; offset += 1) {
    for (const candidate of [base + offset, base - offset]) {
      if (candidate <= 0) continue;
      const id = String(candidate);
      if (exclude.has(id)) continue;
      ids.push(id);
    }
  }
  return ids;
}

/** The app's iOS version ids, newest first — `[0]` is what a guess offsets from. */
async function listIOSVersionIds(
  session: ReturnType<typeof createDownloadSession>,
): Promise<string[]> {
  const iosSession = createDownloadSession(session.account, {
    ...session.app,
    platform: "ios",
  });
  const reply = await requestDownloadProduct(iosSession, "");
  assertListVersionsReply(reply);
  return versionIdentifiersFromReply(reply);
}

/**
 * True when the target platform's exchange serves `candidate` — the guess is
 * the real exchange with the candidate as its pin, so a satisfied reply is the
 * whole validation. Runs on its own cookie copy: probe traffic must not race
 * the session's own cookie bookkeeping.
 */
async function servesPlatformVersion(
  session: ReturnType<typeof createDownloadSession>,
  candidate: string,
): Promise<boolean> {
  try {
    const probe = { ...session, cookies: [...session.cookies] };
    const reply = await requestDownloadProduct(probe, candidate);
    assertListVersionsReply(reply);
    return true;
  } catch {
    return false;
  }
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
