import { useCallback, useEffect, useRef } from "react";
import {
  fetchPackageVersionMetadata,
  fetchVersionMetadata,
  saveVersionMetadata,
} from "../api/versionMetadata";
import { getDownloadInfo } from "../apple/download";
import { getVersionMetadata } from "../apple/versionLookup";
import { useAccountsStore } from "../store/accounts";
import { useSettingsStore } from "../store/settings";
import { useVersionMetadataStore } from "../store/versionMetadata";
import type { Account, Software, VersionMetadata } from "../types";

/** At most this many missing versions are filled per version list load. */
const PREFETCH_MAX_VERSIONS = 100;
/** The first stretch fills this many versions with this many lookups in flight... */
const PREFETCH_FAST_COUNT = 20;
const PREFETCH_FAST_CONCURRENCY = 5;
/** ...and the remainder politely one at a time. */
const PREFETCH_SLOW_CONCURRENCY = 1;

/**
 * Whether a version still needs looking up. A version with no entry at all
 * does — and so does one whose entry is not package-sourced: it shows a number
 * with no date, and reading its package is the only way to add one, because
 * the exchange's own date is app-level and would be wrong on every row.
 */
function needsFill(entry: VersionMetadata | undefined): boolean {
  return !entry || entry.source !== "package";
}

/**
 * Fills one version's metadata the ipatool way. One pinned exchange names the
 * build *and* hands back its download URL, and the backend then reads the
 * build's own release date out of that package: Apple's exchange metadata dates
 * the *app* — the same day for every version of a list — so a date taken from
 * it would be wrong for every row but the app's first.
 *
 * When the package read fails, the exchange's reply still fills the display
 * version, minus the date it cannot vouch for.
 */
async function fillAccurate(
  account: Account,
  app: Software,
  versionId: string,
): Promise<void> {
  const store = () => useVersionMetadataStore.getState();
  try {
    const { output, updatedCookies } = await getDownloadInfo(
      account,
      app,
      versionId,
    );
    // Refresh the session cookies, but never let a failed refresh block the
    // package read — the date matters more than the bookkeeping.
    try {
      await useAccountsStore
        .getState()
        .updateAccount({ ...account, cookies: updatedCookies });
    } catch {
      // Bookkeeping only.
    }

    const fromPackage = await fetchPackageVersionMetadata(
      app.id,
      versionId,
      output.downloadURL,
    );
    if (fromPackage) {
      store().putEntry(versionId, fromPackage);
      return;
    }
    // No package to read: the display version stands, the date does not.
    store().putEntry(versionId, {
      displayVersion: output.bundleShortVersionString,
      releaseDate: "",
      source: "client",
    });
  } catch {
    // The pinned exchange failed (session, license, macOS package): the older
    // exchange still fills the display version, without a date.
    const result = await getVersionMetadata(account, app, versionId);
    store().putEntry(versionId, { ...result.metadata, source: "client" });
    await useAccountsStore
      .getState()
      .updateAccount({ ...account, cookies: result.updatedCookies });
  }
}

/**
 * Session-wide version metadata map. `ensureLoaded` pulls the backend's shared
 * cache once a version list has loaded; `recordMetadata` stores a metadata the
 * page fetched live from Apple (and writes it back to the backend); and
 * `prefetchMissing` silently fills versions that still have none — up to a
 * hundred per call, five lookups in flight for the first twenty and the rest
 * one at a time. Leaving the page cancels the queue; lookups already in
 * flight finish and stay written back. Nothing here ever rejects: failures
 * leave the manual per-version button as the fallback.
 */
export function useVersionMetadataMap() {
  const versionMeta = useVersionMetadataStore((s) => s.entries);
  const pendingMeta = useVersionMetadataStore((s) => s.pending);

  const ensureLoaded = useCallback(async (appId: string | number) => {
    const entries = await fetchVersionMetadata(appId);
    if (Object.keys(entries).length === 0) return;
    // Cached-first: an entry already on screen is never replaced.
    useVersionMetadataStore.getState().mergeEntries(entries);
  }, []);

  /**
   * Records a metadata the page just fetched live from Apple: it shows up
   * immediately and is written back to the backend so other browsers can
   * reuse it (both steps best-effort).
   */
  const recordMetadata = useCallback(
    (appId: string | number, versionId: string, metadata: VersionMetadata) => {
      useVersionMetadataStore.getState().putEntry(versionId, metadata);
      void saveVersionMetadata(appId, versionId, metadata);
    },
    [],
  );

  const activePrefetches = useRef<Set<{ cancelled: boolean }>>(new Set());
  /**
   * False once the page is gone. A fill that starts *after* an await (the
   * silent policy waits for the shared cache first) would otherwise queue a
   * hundred lookups for a page nobody is looking at.
   */
  const mounted = useRef(true);

  // Leaving the page interrupts the silent pass: nothing new is queued while
  // lookups already in flight finish — and stay written back, each result
  // persisting the moment it lands. Re-armed on setup, not only cleared on
  // cleanup: React StrictMode runs setup → cleanup → setup on mount, and the
  // first cleanup's `false` would otherwise mute every fill (see AGENTS.md).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const run of activePrefetches.current) run.cancelled = true;
      activePrefetches.current.clear();
    };
  }, []);

  /**
   * Silently fills metadata for versions a package has not vouched a date
   * for — up to a hundred per call, five lookups in flight for the first
   * twenty and the rest one at a time — and keeps the session cookies fresh
   * along the way. It runs on the freshest stored copy of the account: the
   * caller's object can predate the cookie refresh its version-list exchange
   * just wrote back.
   *
   * A version the automatic pass already tried this session is left alone —
   * on a delisted app most builds cannot be served, and every visit must not
   * re-ask for all of them. The manual check passes `force` and does ask
   * again.
   *
   * Fire-and-forget: never blocks, never toasts, per-version failures are
   * ignored, and the automation switch turns the automatic path off — the
   * card's manual 查版本号 button passes `force` to run the same fill on
   * demand. The returned promise settles when the run ends or is cancelled.
   */
  const prefetchMissing = useCallback(
    (
      account: Account,
      app: Software,
      versions: string[],
      options?: { force?: boolean },
    ) => {
      const run = { cancelled: false };
      // A page that already went away gets no new lookups at all.
      if (!mounted.current) return Promise.resolve();
      activePrefetches.current.add(run);

      const runPromise = (async () => {
        try {
          if (
            !options?.force &&
            !useSettingsStore.getState().autoFetchVersionInfo
          ) {
            return;
          }

          // Use the freshest session, not the caller's snapshot: the version
          // list load refreshed the cookies and already stored them.
          const freshest =
            useAccountsStore
              .getState()
              .accounts.find((stored) => stored.email === account.email) ??
            account;

          const known = useVersionMetadataStore.getState().entries;
          const { attempted } = useVersionMetadataStore.getState();
          const missing = versions
            .filter((versionId) => {
              if (!needsFill(known[versionId])) return false;
              // The automatic pass does not ask twice in a session; the
              // manual check does, which is the point of pressing it.
              return (
                Boolean(options?.force) ||
                !attempted[`${app.id}:${versionId}`]
              );
            })
            .slice(0, PREFETCH_MAX_VERSIONS);
          if (missing.length === 0) return;

          const fillOne = async (versionId: string) => {
            const store = useVersionMetadataStore.getState();
            store.markAttempted(`${app.id}:${versionId}`);
            // Pickers show a fetching state for ids in flight.
            store.setPending(versionId, true);
            try {
              await fillAccurate(freshest, app, versionId);
            } catch {
              // Silent — the row keeps its manual "load details" button.
            } finally {
              useVersionMetadataStore.getState().setPending(versionId, false);
            }
          };

          const fillRange = async (range: string[], concurrency: number) => {
            let next = 0;
            const worker = async () => {
              while (next < range.length && !run.cancelled) {
                const versionId = range[next];
                next += 1;
                await fillOne(versionId);
              }
            };
            await Promise.all(
              Array.from(
                { length: Math.min(concurrency, range.length) },
                worker,
              ),
            );
          };

          await fillRange(
            missing.slice(0, PREFETCH_FAST_COUNT),
            PREFETCH_FAST_CONCURRENCY,
          );
          if (!run.cancelled) {
            await fillRange(
              missing.slice(PREFETCH_FAST_COUNT),
              PREFETCH_SLOW_CONCURRENCY,
            );
          }
        } finally {
          activePrefetches.current.delete(run);
        }
      })().catch(() => undefined);

      // The automatic path drops the promise; the manual one awaits it to
      // keep its busy label honest.
      return runPromise;
    },
    [recordMetadata],
  );

  /**
   * The silent version-number policy a version picker opens with: fold the
   * backend's shared cache in first — anything it already dated needs no Apple
   * request — then fill whatever still lacks a package-vouched date in the
   * background.
   *
   * The cache step is awaited on purpose (this is what the old new-download
   * page did): starting the fill before it lands would ask Apple about versions
   * the instance already has answers for. A cache failure is swallowed and the
   * fill runs regardless — it is an optimisation, not a prerequisite.
   */
  const fillVersionsSilently = useCallback(
    (
      account: Account,
      app: Software,
      versions: string[],
      options?: { force?: boolean },
    ) => {
      // The promise is returned so a caller that wants to wait — the manual
      // 查版本号 button, which keeps a busy label — can.
      return (async () => {
        try {
          await ensureLoaded(app.id);
        } catch {
          // The shared cache is unavailable; the fill still asks Apple.
        }
        // The page may have gone away while the cache was loading; a fill
        // started now would run for nobody.
        if (!mounted.current) return;
        return prefetchMissing(account, app, versions, options);
      })();
    },
    [ensureLoaded, prefetchMissing],
  );

  return {
    versionMeta,
    pendingMeta,
    ensureLoaded,
    recordMetadata,
    prefetchMissing,
    fillVersionsSilently,
  };
}
