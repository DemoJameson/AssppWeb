import { create } from "zustand";
import type { VersionMetadata } from "../types";
import { dateComesFromPackage } from "../utils/versionMetadataSource";

/**
 * Session-wide version metadata map, shared by every page: merged from the
 * backend's instance cache and from live Apple lookups this session made.
 * First write wins per version id — a value already on screen is never
 * replaced, mirroring the backend's cached-first merge.
 */
interface VersionMetadataState {
  entries: Record<string, VersionMetadata>;
  /** Version ids whose metadata is being fetched right now. */
  pending: Record<string, boolean>;
  /**
   * `appId:versionId` ids the automatic pass already tried this session: a
   * build Apple will not serve again must not be re-asked on every visit. The
   * manual check ignores it — an explicit retry is the user's call.
   */
  attempted: Record<string, true>;
  markAttempted: (key: string) => void;
  mergeEntries: (entries: Record<string, VersionMetadata>) => void;
  putEntry: (versionId: string, metadata: VersionMetadata) => void;
  setPending: (versionId: string, pending: boolean) => void;
}

export const useVersionMetadataStore = create<VersionMetadataState>((set) => ({
  entries: {},
  pending: {},
  attempted: {},

  markAttempted: (key) =>
    set((state) =>
      state.attempted[key]
        ? state
        : { attempted: { ...state.attempted, [key]: true } },
    ),

  mergeEntries: (entries) =>
    set((state) => {
      // Cached-first means a merge can only ever *add*: every id the store
      // already knows keeps its own value. When there is nothing to add — the
      // daily case of a page folding the shared cache in a second time — the
      // state is handed back untouched. A fresh `entries` object would wake
      // every subscriber of the store, and the pages that fold the cache in are
      // among them: read → merge → re-render → read is a request loop.
      const fresh = Object.keys(entries).some((id) => !state.entries[id]);
      if (!fresh) return state;
      return { entries: { ...entries, ...state.entries } };
    }),

  putEntry: (versionId, metadata) =>
    set((state) => {
      const existing = state.entries[versionId];
      // A date read out of a package is the build's own and displaces whatever
      // the exchange said; everything else keeps the first write. Asking
      // `dateComesFromPackage` rather than naming `package` is what lets a value
      // filled in by `fillAccurate` — a `package-read` — land here at all: it is
      // the only path that brings a build's date into this store.
      if (existing && !dateComesFromPackage(metadata.source)) return state;
      return { entries: { ...state.entries, [versionId]: metadata } };
    }),

  setPending: (versionId, pending) =>
    set((state) => {
      if (pending) {
        if (state.pending[versionId]) return state;
        return { pending: { ...state.pending, [versionId]: true } };
      }
      if (!state.pending[versionId]) return state;
      const { [versionId]: _settled, ...rest } = state.pending;
      return { pending: rest };
    }),
}));
