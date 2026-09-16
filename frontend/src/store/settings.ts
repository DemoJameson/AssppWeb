import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parsePlatform } from "../apple/platform";
import type { Platform } from "../types";

type ThemeType = "light" | "dark" | "system";

interface SettingsState {
  defaultCountry: string;
  defaultPlatform: Platform;
  theme: ThemeType;
  setDefaultCountry: (country: string) => void;
  setDefaultPlatform: (platform: Platform) => void;
  setTheme: (theme: ThemeType) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultCountry: "US",
      defaultPlatform: "ios",
      theme: "light",
      setDefaultCountry: (country) => set({ defaultCountry: country }),
      setDefaultPlatform: (platform) => set({ defaultPlatform: platform }),
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
