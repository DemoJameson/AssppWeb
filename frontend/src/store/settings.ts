import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parsePlatform } from "../apple/platform";
import type { Platform } from "../types";

type ThemeType = "light" | "dark" | "system";

interface SettingsState {
  defaultCountry: string;
  defaultPlatform: Platform;
  /**
   * Email of the account the user last picked in an account selector. Every
   * selector reuses it while the account is available, so multi-account
   * setups do not have to re-pick on each page.
   */
  defaultAccount: string;
  theme: ThemeType;
  setDefaultCountry: (country: string) => void;
  setDefaultPlatform: (platform: Platform) => void;
  setDefaultAccount: (account: string) => void;
  setTheme: (theme: ThemeType) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultCountry: "US",
      defaultPlatform: "ios",
      defaultAccount: "",
      theme: "light",
      setDefaultCountry: (country) => set({ defaultCountry: country }),
      setDefaultPlatform: (platform) => set({ defaultPlatform: platform }),
      setDefaultAccount: (account) => set({ defaultAccount: account }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "asspp-settings",
      version: 1,
      migrate: (persisted) => {
        const state = persisted as Partial<SettingsState> & {
          defaultEntity?: unknown;
        };
        // v0 stored the search entity as "iPhone"/"iPad".
        const legacyEntity = state.defaultEntity;
        delete (state as Record<string, unknown>).defaultEntity;
        const platform =
          parsePlatform(state.defaultPlatform) ??
          (legacyEntity === "iPad" ? "ipad" : "ios");
        return { ...state, defaultPlatform: platform } as SettingsState;
      },
    },
  ),
);
