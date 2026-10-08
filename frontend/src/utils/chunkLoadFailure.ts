/** Recognising a failed dynamic `import()`, shared by `lazyWithRetry` (whether to
 * reload) and `AppErrorBoundary` (whether "try again" would be honest), so the two
 * must never disagree. The match is deliberately narrow: a bare `/failed to fetch/i`
 * would also catch `appleRequest`'s TypeError and reload away the user's in-flight
 * downloads.
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
