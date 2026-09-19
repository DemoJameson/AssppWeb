import { create } from "zustand";

/**
 * Page-session cache of fetched version lists, keyed by `appId:platform:region`.
 *
 * The region is part of the key because the exchange is answered *by an
 * account*: a different storefront can serve a different list (or none), so a
 * list fetched for one region must never be shown for another — the cache only
 * ever answers for the region it was asked from.
 *
 * The new-download page fetches a delisted app's version list as part of the
 * lookup — so the newest version is known by the time the card shows — and
 * caches it here; 选择版本 then opens straight from the cache instead of
 * running another Apple exchange.
 *
 * Page memory only, deliberately: nothing is written to web storage, so a
 * page reload starts empty and the next lookup always fetches a fresh list
 * from Apple. The cache only ever saves re-exchanges within the same page.
 */
interface VersionListsState {
  lists: Record<string, string[]>;
}

export const useVersionListsStore = create<VersionListsState>(() => ({
  lists: {},
}));

/**
 * The cache key for one exchange: the app, the platform it was asked for, and
 * the storefront that answered (`country` — the account region the exchange
 * ran under, see {@link accountStoreCountry}). Callers that cannot name a
 * region yet get the `""` bucket, which no exchange writes into: a cache hit
 * then is impossible by construction rather than by luck.
 */
export function versionListKey(
  appId: string | number,
  platform?: string,
  country?: string,
): string {
  return `${appId}:${platform ?? "ios"}:${country ?? ""}`;
}

export function getCachedVersionList(key: string): string[] | undefined {
  return useVersionListsStore.getState().lists[key];
}

export function rememberVersionList(key: string, versions: string[]): void {
  useVersionListsStore.setState((state) => ({
    lists: { ...state.lists, [key]: versions },
  }));
}

/** Exchanges already running, keyed like the cache (or by a caller's flow key). */
const inflight = new Map<string, Promise<string[]>>();

/**
 * Runs a version-list exchange at most once per key while one is in flight, and
 * caches what comes back.
 *
 * Leaving a page mid-exchange cannot call it off — the Apple exchange has no
 * abort — but it must not cost a second one: a quick return re-attaches to the
 * running exchange instead of asking Apple again.
 *
 * `flowKey` scopes that re-attachment beyond the cache key: the bare-App-ID
 * probe passes its region-scoped key so a region switch starts a fresh
 * exchange instead of adopting one asked from another storefront. The cache
 * write still uses `key`.
 */
export function ensureVersionList(
  key: string,
  run: () => Promise<{ versions: string[] }>,
  flowKey?: string,
): Promise<string[]> {
  const slot = flowKey ?? key;
  const pending = inflight.get(slot);
  if (pending) return pending;

  const promise = run()
    .then((result) => {
      rememberVersionList(key, result.versions);
      return result.versions;
    })
    .finally(() => {
      inflight.delete(slot);
    });

  inflight.set(slot, promise);
  return promise;
}
