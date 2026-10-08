import { create } from "zustand";

/**
 * Page-session cache of fetched version lists, keyed by `appId:platform:region`.
 * The region is part of the key because the exchange is answered *by an account*,
 * so a list fetched for one region must never be shown for another. Page memory
 * only — a reload starts empty and refetches fresh from Apple.
 */
interface VersionListsState {
  lists: Record<string, string[]>;
}

export const useVersionListsStore = create<VersionListsState>(() => ({
  lists: {},
}));

/**
 * Cache key for one exchange: app, platform, and the answering storefront
 * (`country`, the account region, see {@link accountStoreCountry}). Callers with
 * no region yet get the `""` bucket, which no exchange writes into.
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
 * Runs a version-list exchange at most once per key while one is in flight and
 * caches the result. An Apple exchange has no abort, so leaving a page mid-flight
 * cannot call it off — a quick return re-attaches instead of asking again.
 * `flowKey` scopes that re-attachment (a region switch starts fresh); `key` is
 * still what gets cached.
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
