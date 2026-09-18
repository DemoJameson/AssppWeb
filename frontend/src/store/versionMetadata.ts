import { create } from "zustand";
import type { VersionMetadata } from "../types";

/**
 * Session-wide version metadata map, shared by every page: merged from the
 * backend's instance cache and from live Apple lookups this session made.
 * First write wins per version id — a value already on screen is never
 * replaced, mirroring the backend's cached-first merge.
 */
interface VersionMetadataState {
  entries: Record<string, VersionMetadata>;
  mergeEntries: (entries: Record<string, VersionMetadata>) => void;
  putEntry: (versionId: string, metadata: VersionMetadata) => void;
}

export const useVersionMetadataStore = create<VersionMetadataState>((set) => ({
  entries: {},

  mergeEntries: (entries) =>
    set((state) => ({ entries: { ...entries, ...state.entries } })),

  putEntry: (versionId, metadata) =>
    set((state) =>
      state.entries[versionId]
        ? state
        : { entries: { ...state.entries, [versionId]: metadata } },
    ),
}));
