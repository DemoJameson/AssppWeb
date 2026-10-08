/**
 * Recognising a failed dynamic `import()`.
 *
 * Lives in its own module because two places need the same answer and must
 * never disagree: `lazyWithRetry` uses it to decide whether a reload is worth
 * attempting, and `AppErrorBoundary` uses it to decide whether offering a
 * "try again" button would be honest. A boundary that disagreed with the retry
 * logic would either show a dead button or hide the only action that works.
 *
 * The match is deliberately narrow. A bare `/failed to fetch/i` would also
 * catch the app's own `fetch()` failures — `appleRequest` rejects with a
 * TypeError carrying exactly that wording — and reloading the page because a
 * request to Apple failed would discard the user's in-flight downloads for no
 * reason. Only the messages the browser produces for a module script that never
 * arrived count.
 */

/** V8/Chromium wording for a module script that failed to load. */
const DYNAMIC_IMPORT_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module/i;

/** Firefox's wording for the same failure. */
const MODULE_FETCH_FAILURE = /error loading dynamically imported module|importing a module script failed/i;

export function isChunkLoadFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message;
  return DYNAMIC_IMPORT_FAILURE.test(message) || MODULE_FETCH_FAILURE.test(message);
}
