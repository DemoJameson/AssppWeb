// The neighbour-id guess that names a platform pin for a delisted app. Lives
// apart from `downloadProduct.ts` so the exchange can call it without a cycle,
// and from `versionFinder.ts` so mocking `requestDownloadProduct` still
// intercepts the guess's probes.

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
 * ruled out: every pin platform minus iOS, whose ids the offset list already
 * carries.
 */
const OTHER_PIN_PLATFORMS: Platform[] = ["tvos", "visionos", "macos"];

/** Ceiling on the distance a guessed platform pin may sit from the iOS id. */
const PIN_GUESS_MAX_OFFSET = 6;
/** How many of those probes may run at once. */
const PIN_GUESS_CONCURRENCY = 6;

/** Guesses the target platform's pin for a delisted app from the newest iOS version id:
 * a release's builds ship together, so their external ids are *adjacent* across platforms.
 * Neighbours are probed nearest-first against the target's own exchange, `PIN_GUESS_CONCURRENCY`
 * at a time, until one is served. It can only rule ids *out* (the iOS list's ids and every
 * foreign id — see {@link foreignPlatformVersionIds}), giving up after `PIN_GUESS_MAX_OFFSET` each way.
 */
export async function guessPlatformPinFromIOSList(
  session: DownloadSession,
): Promise<string | undefined> {
  // A failure to read the iOS list is "we never got to ask", not "this platform
  // has no build": it travels up as the failure it is, leaving the question open.
  const versions = await listIOSVersionIds(session);

  const newest = Number(versions[0] ?? "");
  // Version ids are positive integers; anything else cannot be offset into a
  // neighbour of itself.
  if (!Number.isSafeInteger(newest) || newest <= 0) return undefined;

  // Every id another platform is known by is off limits: an id recorded under
  // tvOS is a tvOS build, however well it probes here. The iOS list joins the set
  // for the history check below, so a probe that falls back to the iOS history
  // does not read as a hit.
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

/** The ids adjacent to `base`, nearest first, so a nearer one is probed before the
 * step beyond it. `exclude` holds the iOS list's ids — including `base`, its newest —
 * which are iOS builds and never candidates here.
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

/** The ids belonging to the app's *other* platforms, from three best-effort sources: the
 * id each other platform's own source names now (tvOS MDM catalogue, macOS/visionOS storefront
 * pages); every id a past download recorded under another platform (builds no catalogue lists
 * any more); and every build the package-app index holds under another platform (its *older*
 * builds — the pin store keeps only the newest id). A silent source just means one less id ruled out.
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

/** True when the target platform's exchange serves `candidate` *as this platform's
 * build*: the reply must satisfy the exchange, its artifact must be one the platform
 * installs (`.pkg`/IPA — see `artifactMatchesPlatform`), and its version history must
 * name no id known under another platform (an id names its own platform regardless of
 * the asking device). Runs on its own cookie copy so probes don't race the session's.
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
    // else, so a candidate this platform could never install is refused however
    // obligingly Apple served it.
    const item = itemsOf(reply)[0];
    const url = item?.URL;
    if (
      typeof url !== "string" ||
      url === "" ||
      !artifactMatchesPlatform(url, session.app.platform)
    ) {
      return false;
    }

    // The reply also names the served build's whole platform history (the same
    // list 选择版本 would show). A history that mentions an id already known under
    // another platform (or the iOS list) means the pin landed on that platform's
    // build — the check that catches builds no exclusion source could name.
    const history = versionIdentifiersFromReply(reply);
    return !history.some((id) => knownForeign.has(id));
  } catch {
    return false;
  }
}