import { useCallback } from "react";
import {
  fetchVersionMetadata,
  saveVersionMetadata,
} from "../api/versionMetadata";
import { getVersionMetadata } from "../apple/versionLookup";
import { useAccountsStore } from "../store/accounts";
import { useSettingsStore } from "../store/settings";
import { useVersionMetadataStore } from "../store/versionMetadata";
import type { Account, Software, VersionMetadata } from "../types";

/** At most this many missing versions are filled per version list load. */
const PREFETCH_MAX_VERSIONS = 20;
/** At most this many prefetch lookups run at the same time. */
const PREFETCH_CONCURRENCY = 5;

/**
 * Session-wide version metadata map. `ensureLoaded` pulls the backend's shared
 * cache once a version list has loaded; `recordMetadata` stores a metadata the
 * page fetched live from Apple (and writes it back to the backend); and
 * `prefetchMissing` silently fills versions that still have none — at most
 * twenty per call, five lookups in flight. Nothing here ever rejects: failures
 * leave the manual per-version button as the fallback.
 */
export function useVersionMetadataMap() {
  const versionMeta = useVersionMetadataStore((s) => s.entries);

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

  /**
   * Silently fills metadata for versions that have none yet — at most twenty
   * per call, five lookups in flight — and keeps the session cookies fresh
   * along the way. It runs on the freshest stored copy of the account: the
   * caller's object can predate the cookie refresh its version-list exchange
   * just wrote back. Fire-and-forget: never blocks, never toasts, per-version
   * failures are ignored, and the automation switch can turn it off entirely.
   */
  const prefetchMissing = useCallback(
    (account: Account, app: Software, versions: string[]) => {
      void (async () => {
        if (!useSettingsStore.getState().autoFetchVersionInfo) return;

        // Use the freshest session, not the caller's snapshot: the version
        // list load refreshed the cookies and already stored them.
        const freshest =
          useAccountsStore
            .getState()
            .accounts.find((stored) => stored.email === account.email) ??
          account;

        const known = useVersionMetadataStore.getState().entries;
        const missing = versions
          .filter((versionId) => !known[versionId])
          .slice(0, PREFETCH_MAX_VERSIONS);
        if (missing.length === 0) return;

        let next = 0;
        const worker = async () => {
          while (next < missing.length) {
            const versionId = missing[next];
            next += 1;
            try {
              const result = await getVersionMetadata(freshest, app, versionId);
              recordMetadata(app.id, versionId, result.metadata);
              await useAccountsStore
                .getState()
                .updateAccount({ ...freshest, cookies: result.updatedCookies });
            } catch {
              // Silent — the row keeps its manual "load details" button.
            }
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(PREFETCH_CONCURRENCY, missing.length) },
            worker,
          ),
        );
      })();
    },
    [recordMetadata],
  );

  return { versionMeta, ensureLoaded, recordMetadata, prefetchMissing };
}
