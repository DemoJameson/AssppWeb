import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { isChunkLoadFailure } from './chunkLoadFailure';

/**
 * Recovery for `import()` failures.
 *
 * Every route is code-split, so switching tabs is what triggers chunk fetches.
 * Those fetches are the app's most failure-prone requests — many small files,
 * all fired at once, all crossing an edge cache in front of a single origin.
 * When the edge or the origin blinks, the browser rejects the module script
 * with `ERR_ABORTED` (or a 5xx body it refuses to evaluate as JavaScript) and
 * `import()` rejects. Unhandled, that rejection has nowhere to go: React has
 * no error boundary above `<Suspense>`, so the whole tree unmounts and the
 * user gets a blank page with a failed import in the console.
 *
 * Two mechanisms, deliberately kept in this one module because they only make
 * sense together:
 *
 * 1. A bounded retry with backoff. Transient network faults clear on their own,
 *    and the retry is invisible when it works.
 * 2. A single guarded reload. A *persistent* failure usually means the HTML
 *    document came from a deploy the user's cached chunks predate: the page is
 *    running a build whose `assets/*.js` no longer exist. Reloading fetches
 *    the current `index.html` and the current chunks, which is the one thing
 *    that actually fixes it.
 *
 * The guard around the reload stops a page that cannot load from reloading
 * forever. It is deliberately *not* a once-per-session latch: any chunk that
 * loads successfully clears it, so a single unlucky failure does not disable
 * recovery for the rest of the tab's life.
 *
 * Reloading is skipped outside production. On the dev server it would discard
 * Vite's module state for no benefit, and the boundary already renders the
 * failure with the console error intact.
 */

/** Bounded so a real outage still reaches the error boundary quickly. */
const MAX_ATTEMPTS = 3;

/** Grows per attempt: an origin that is restarting does not recover instantly. */
const BASE_DELAY_MS = 400;

const RELOAD_GUARD_KEY = 'asspp:chunk-reload';

/**
 * Clears the guard once a chunk has loaded successfully.
 *
 * Without this the guard would be write-once per tab: one flaky failure would
 * disable automatic recovery for every later failure in the same session, even
 * ones a reload would have fixed. The guard's job is to stop a *loop*, not to
 * remember that a reload ever happened — so it is cleared as soon as it is no
 * longer needed, which is the moment the build turns out to be fine.
 */
function clearReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // Ignore — see alreadyReloaded().
  }
}

function alreadyReloaded(): boolean {
  try {
    return window.sessionStorage.getItem(RELOAD_GUARD_KEY) !== null;
  } catch {
    // Private-mode Safari and similar: treat "cannot remember" as "no", which
    // only risks one extra reload attempt before the boundary takes over.
    return false;
  }
}

function rememberReload(): void {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  } catch {
    // Nothing to do — see above.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `React.lazy` with a fetch that survives a flaky edge.
 *
 * React memoizes the promise returned by the factory, so the retry lives
 * inside this factory rather than around `lazy()` — a wrapper that re-calls
 * `lazy()` would throw away the component identity and remount the subtree.
 */
export function lazyWithRetry<P extends object>(
  factory: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await delay(BASE_DELAY_MS * attempt);
      try {
        const module = await factory();
        // The build turned out to be loadable, so the reload guard (if a
        // previous failure set one) has served its purpose.
        clearReloadGuard();
        return module;
      } catch (error) {
        lastError = error;
      }
    }

    // Only a genuine module-script failure justifies a reload, and only where
    // a reload can actually fetch a different build.
    if (
      isChunkLoadFailure(lastError) &&
      import.meta.env.PROD &&
      !alreadyReloaded()
    ) {
      // Persist across the reload so the guard survives the navigation.
      rememberReload();
      window.location.reload();
      // The document is going away; resolving never keeps the old tree alive
      // long enough to flash an error at a user who is already getting a new
      // page. If the reload is blocked, the boundary still catches the
      // rejection and offers a button.
      return await new Promise<{ default: ComponentType<P> }>(() => {});
    }

    throw lastError;
  });
}

/** Test seam — lets the suite reset the reload guard between cases. */
export const resetReloadGuardForTests = clearReloadGuard;
