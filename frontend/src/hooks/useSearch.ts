import { create } from "zustand";
import { persist } from "zustand/middleware";
import { searchApps, lookupApp, lookupAppById } from "../api/search";
import { looksLikeBundleId } from "../utils/bundleId";
import { appIdFromStoreUrl } from "../utils/appStoreUrl";
import { bareSoftwareById } from "../utils/software";
import type { Platform, Software } from "../types";

interface SearchState {
  term: string;
  country: string;
  /**
   * Empty until the search page seeds it. The pair of country and platform is
   * persisted, so a visit opens where the previous one left off.
   */
  platform: Platform | "";
  results: Software[];
  loading: boolean;
  error: string | null;
  /** Whether a search has completed — tells a real miss apart from “not searched yet”. */
  searched: boolean;
  setSearchParam: (
    param: Partial<Pick<SearchState, "term" | "country" | "platform">>,
  ) => void;
  search: (
    term: string,
    country: string,
    platform: Platform,
  ) => Promise<void>;
  lookup: (bundleId: string, country: string) => Promise<void>;
  /**
   * Drops a result the version exchange proved is not an app (see
   * `isMissingAppError`): a bare App ID is only offered while something is
   * still behind it to fetch.
   */
  dropResult: (id: number) => void;
  /**
   * Clears the search state (term, results, error) while keeping the selected
   * country and platform as user preferences.
   */
  clear: () => void;
}

// Guards against out-of-order responses: flipping the platform/region fires
// searches in quick succession, and only the newest one may land.
let searchSeq = 0;

export const useSearch = create<SearchState>()(
  persist(
    (set) => ({
      term: "",
      country: "",
      platform: "",
      results: [],
      loading: false,
      error: null,
      searched: false,
      setSearchParam: (param) => set((state) => ({ ...state, ...param })),
      search: async (term, country, platform) => {
        const seq = ++searchSeq;
        set({ loading: true, error: null, term, country, platform });
        try {
          const trimmed = term.trim();
          // A store link or a numeric App ID is not a search term: route it
          // through the exact id lookup, which also recalls delisted apps from
          // the backend's package index.
          const storeId = /^\d+$/.test(trimmed)
            ? trimmed
            : appIdFromStoreUrl(trimmed);
          let next: Software[];
          if (storeId) {
            // A resolved id is used as-is; a missed one stays usable as a bare
            // record — the version exchange can still fetch it directly, and what
            // that exchange answers decides whether the record survives (see the
            // search page's probe).
            const app = await lookupAppById(storeId, country, platform);
            next = app ? [app] : [bareSoftwareById(storeId, platform)];
          } else if (looksLikeBundleId(term)) {
            const app = await lookupApp(term.trim(), country, platform);
            next = app ? [app] : [];
          } else {
            next = await searchApps(term, country, platform);
          }
          if (seq === searchSeq) set({ results: next, searched: true });
        } catch (e) {
          if (seq === searchSeq) {
            set({
              error: e instanceof Error ? e.message : "Search failed",
              results: [],
              searched: true,
            });
          }
        } finally {
          if (seq === searchSeq) set({ loading: false });
        }
      },
      lookup: async (bundleId, country) => {
        set({ loading: true, error: null });
        try {
          const app = await lookupApp(bundleId, country);
          set({ results: app ? [app] : [], searched: true });
        } catch (e) {
          set({
            error: e instanceof Error ? e.message : "Lookup failed",
            results: [],
            searched: true,
          });
        } finally {
          set({ loading: false });
        }
      },
      // Clears the keyword, results and error, but keeps the selected country and
      // platform (user preferences).
      clear: () => set({ term: "", results: [], error: null, searched: false }),
      dropResult: (id) =>
        set((state) => {
          const results = state.results.filter((app) => app.id !== id);
          return results.length === state.results.length ? state : { results };
        }),
    }),
    {
      name: "asspp-search",
      // Only the dimensions are a preference; the term and the results are
      // this visit's page state.
      partialize: (state) => ({
        country: state.country,
        platform: state.platform,
      }),
    },
  ),
);
