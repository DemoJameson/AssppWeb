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
import i18n from "../i18n";

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
export async function guessPlatformPinFromIOSList(
  session: DownloadSession,
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
 * True when the target platform's exchange serves `candidate` — the guess is
 * the real exchange with the candidate as its pin, so a satisfied reply is the
 * whole validation. Runs on its own cookie copy: probe traffic must not race
 * the session's own cookie bookkeeping.
 */
async function servesPlatformVersion(
  session: DownloadSession,
  candidate: string,
): Promise<boolean> {
  try {
    const probe = { ...session, cookies: [...session.cookies] };
    const reply = await requestDownloadProduct(probe, candidate);
    return failureTypeOf(reply) === "" && itemsOf(reply).length > 0;
  } catch {
    return false;
  }
}