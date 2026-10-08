import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { isChunkLoadFailure } from './chunkLoadFailure';

/**
 * Recovery for `import()` failures: bounded retries with backoff, then one guarded
 * reload for a production chunk-load error — a page whose cached chunks predate a
 * deploy, the only case a reload fixes. Any successful chunk clears the guard, so
 * one unlucky failure cannot disable recovery for the tab's life; dev skips the
 * reload to keep Vite's module state.
 */

/** Bounded so a real outage still reaches the error boundary quickly. */
const MAX_ATTEMPTS = 3;

/** Grows per attempt: an origin that is restarting does not recover instantly. */
const BASE_DELAY_MS = 400;

const RELOAD_GUARD_KEY = 'asspp:chunk-reload';

/** Clears the guard so a later failure in the same tab can still reload. */
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
    // Private-mode Safari: treat "cannot remember" as "no", risking one extra
    // reload before the boundary takes over.
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
 * `React.lazy` with a fetch that survives a flaky edge. The retry lives inside
 * the factory because React memoizes its promise — re-calling `lazy()` would
 * throw away the component identity and remount the subtree.
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
        // The build loaded, so any guard from a previous failure has served its purpose.
        clearReloadGuard();
        return module;
      } catch (error) {
        lastError = error;
      }
    }

    // Only a genuine module-script failure justifies a reload, and only where
    // a reload can fetch a different build (production).
    if (
      isChunkLoadFailure(lastError) &&
      import.meta.env.PROD &&
      !alreadyReloaded()
    ) {
      // Persist across the reload so the guard survives the navigation.
      rememberReload();
      window.location.reload();
      // Never resolve: the document is going away, and keeping the old tree
      // alive would flash an error at a user already getting a new page. If
      // the reload is blocked, the boundary catches the rejection.
      return await new Promise<{ default: ComponentType<P> }>(() => {});
    }

    throw lastError;
  });
}

/** Test seam — lets the suite reset the reload guard between cases. */
export const resetReloadGuardForTests = clearReloadGuard;
