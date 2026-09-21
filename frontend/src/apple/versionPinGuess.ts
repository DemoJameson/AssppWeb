// The neighbour-id guess that names a platform pin for a delisted app. Lives
// apart from `downloadProduct.ts` so the exchange can call it without a cycle,
// and apart from `versionFinder.ts` so mocking `requestDownloadProduct` in tests
// still intercepts the guess's probes — a same-module call would bypass the
// mock and hit the real exchange.

import {
  createDownloadSession,
  failureTypeOf,
  itemsOf,
  requestDownloadProduct,
  versionIdentifiersFromReply,
  type DownloadSession,
} from "./downloadProduct";
import { DownloadError } from "./errors";
import { artifactMatchesPlatform } from "./platform";
import { latestVersionIdForPlatform } from "./platformVersion";
import { recordedVersionIdsExceptPlatform } from "./versionPins";
import { fetchPackageBuilds } from "../api/packageBuilds";
import { storeIdToCountry } from "./config";
import type { Platform } from "../types";
import i18n from "../i18n";

/**
 * The platforms worth asking about another platform's id, so their build can be
 * ruled out: every platform a pin is resolved for, minus iOS — the iOS list the
 * guess offsets from already carries every iOS id Apple offers.
 */
const OTHER_PIN_PLATFORMS: Platform[] = ["tvos", "visionos", "macos"];

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
 * Neither source can say which platform an id belongs to — the exchange serves
 * whatever build the id names, whatever device class the session asks for — so
 * the guess can only rule ids *out*: every id the iOS list carries, and every
 * id another platform is known by (see {@link foreignPlatformVersionIds}).
 * That is what keeps a macOS page from being handed the tvOS build that sits
 * one id away.
 *
 * Only failures run long: a hit ends the pass, and a pass that walks
 * `PIN_GUESS_MAX_OFFSET` steps each way without a hit gives up.
 */
export async function guessPlatformPinFromIOSList(
  session: DownloadSession,
): Promise<string | undefined> {
  // The iOS list is what any guess offsets from, so a failure to read it is
  // not "this platform has no build" — it is "we never got to ask". It travels
  // up as the failure it is, leaving the question open (the caller says
  // 无法验证, not 没有版本).
  const versions = await listIOSVersionIds(session);

  const newest = Number(versions[0] ?? "");
  // Version ids are positive integers; anything else cannot be offset into a
  // neighbour of itself.
  if (!Number.isSafeInteger(newest) || newest <= 0) return undefined;

  // Every id another platform is known by is off limits: an id a download
  // recorded under tvOS is a tvOS build, and so is the one the tvOS catalogue
  // names right now — however well either probes for this platform. The iOS
  // list joins the set for the *history* check below: a probe that fell back
  // to the account's default build serves the iOS history, which must not read
  // as a hit.
  const foreign = await foreignPlatformVersionIds(session);
  const knownForeign = new Set([...versions, ...foreign]);
  const candidates = neighbourVersionIds(newest, knownForeign);
  for (let start = 0; start < candidates.length; start += PIN_GUESS_CONCURRENCY) {
    const batch = candidates.slice(start, start + PIN_GUESS_CONCURRENCY);
    const probed = await Promise.all(
      batch.map(async (candidate) => ({
        candidate,
        serves: await servesPlatformVersion(session, candidate, knownForeign),
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

/**
 * The version ids that belong to the app's *other* platforms, as far as this
 * instance can tell:
 *
 *   - the id each other platform's own source names right now (the tvOS MDM
 *     catalogue, the macOS and visionOS storefront pages) — reliable for a
 *     build that is still on offer, and consulted precisely so a build this
 *     instance never downloaded can still be ruled out;
 *   - every id a past download recorded under another platform, which covers
 *     the builds no catalogue lists any more because the app is delisted; and
 *   - every build the package-app index holds under another platform, which is
 *     what covers a platform's *older* builds: the pin store keeps only the
 *     newest id per platform, while an app's tvOS history here can hold several
 *     (Forward: the tvOS 1.3.19 pin *and* the tvOS 1.3.18 build, one id away
 *     from the iOS anchor — exactly the neighbour a guess would reach first).
 *
 * All three are best effort: a source that has nothing to say contributes
 * nothing, which only means the guess has one less id it can rule out.
 */
async function foreignPlatformVersionIds(
  session: DownloadSession,
): Promise<string[]> {
  const country = storeIdToCountry(session.account.store) ?? "us";
  const platform = session.app.platform;
  const others = OTHER_PIN_PLATFORMS.filter((other) => other !== platform);

  const [named, recorded, builds] = await Promise.all([
    Promise.all(
      others.map(async (other) => {
        try {
          return await latestVersionIdForPlatform(
            session.app.id,
            country,
            other,
            session.app.bundleID || undefined,
            session.cookies,
          );
        } catch {
          return undefined;
        }
      }),
    ),
    recordedVersionIdsExceptPlatform(session.app.id, platform),
    fetchPackageBuilds(session.app.id),
  ]);

  const indexed = builds
    .filter((build) => build.platform !== platform)
    .map((build) => build.versionId);

  return [
    ...named.filter((id): id is string => typeof id === "string" && id !== ""),
    ...recorded,
    ...indexed.filter((id): id is string => typeof id === "string" && id !== ""),
  ];
}

/** The app's iOS version ids, newest first — `[0]` is what a guess offsets from. */
async function listIOSVersionIds(
  session: DownloadSession,
): Promise<string[]> {
  const iosSession = createDownloadSession(session.account, {
    ...session.app,
    platform: "ios",
  });
  const reply = await requestDownloadProduct(iosSession, "");
  if (failureTypeOf(reply) !== "" || itemsOf(reply).length === 0) {
    throw new DownloadError(i18n.t("errors.versions.missingIdentifiers"));
  }
  return versionIdentifiersFromReply(reply);
}

/**
 * True when the target platform's exchange serves `candidate` *as this
 * platform's build*: the reply must satisfy the exchange, its artifact must be
 * one the platform installs (`.pkg` / IPA, see `artifactMatchesPlatform`), and
 * its version history must name no id known under another platform — an id
 * names its own platform whatever device class asks, so a satisfied reply alone
 * proves nothing. Runs on its own cookie copy: probe traffic must not race the
 * session's own cookie bookkeeping.
 */
async function servesPlatformVersion(
  session: DownloadSession,
  candidate: string,
  knownForeign: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const probe = { ...session, cookies: [...session.cookies] };
    const reply = await requestDownloadProduct(probe, candidate);
    if (failureTypeOf(reply) !== "" || itemsOf(reply).length === 0) {
      return false;
    }

    // The artifact decides: a `.pkg` is a macOS build and an IPA is anything
    // else, so a candidate that this platform could never install is refused
    // however obligingly Apple served it. Without this a macOS page pinned the
    // tvOS build of an iOS-only app — the id names its own platform, and the
    // exchange answers for whatever id it is handed.
    const item = itemsOf(reply)[0];
    const url = item?.URL;
    if (
      typeof url !== "string" ||
      url === "" ||
      !artifactMatchesPlatform(url, session.app.platform)
    ) {
      return false;
    }

    // The reply also names the served build's whole platform history — the
    // same list 选择版本 would show. A history that mentions an id already
    // known under another platform (or the iOS list itself) means the pin
    // landed on that platform's build, however right the artifact looked:
    // this is the fingerprint check that catches builds no exclusion source
    // could name.
    const history = versionIdentifiersFromReply(reply);
    return !history.some((id) => knownForeign.has(id));
  } catch {
    return false;
  }
}