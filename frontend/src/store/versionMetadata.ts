import { create } from "zustand";
import type { VersionMetadata } from "../types";
import { dateComesFromPackage } from "../utils/versionMetadataSource";

/**
 * Session-wide version metadata map, shared by every page: merged from the
 * backend's instance cache and live Apple lookups. First write wins per version
 * id, mirroring the backend's cached-first merge.
 */
interface VersionMetadataState {
  entries: Record<string, VersionMetadata>;
  /** Version ids whose metadata is being fetched right now. */
  pending: Record<string, boolean>;
  /**
   * `appId:versionId` ids the automatic pass already tried this session, so a
   * build Apple will not serve again is not re-asked on every visit. The manual
   * check ignores it — an explicit retry is the user's call.
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
      // Cached-first: a merge only ever *adds*, so every known id keeps its value.
      // Returning a fresh `entries` object when there is nothing to add would wake
      // every subscriber — and the pages that fold the cache in are among them:
      // read → merge → re-render → read is a request loop.
      const fresh = Object.keys(entries).some((id) => !state.entries[id]);
      if (!fresh) return state;
      return { entries: { ...entries, ...state.entries } };
    }),

  putEntry: (versionId, metadata) =>
    set((state) => {
      const existing = state.entries[versionId];
      // A package-read date is the build's own and displaces whatever the exchange
      // said; everything else keeps the first write. Using `dateComesFromPackage`
      // (not a named `package`) is what lets a `package-read` from `fillAccurate`
      // land here at all.
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
