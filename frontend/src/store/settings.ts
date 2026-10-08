import { create } from "zustand";
import { persist } from "zustand/middleware";

type ThemeType = "light" | "dark" | "system";

interface SettingsState {
  /** Fill missing version metadata silently after a version list loads. */
  autoFetchVersionInfo: boolean;
  /** Acquire a missing license automatically, then retry once. */
  autoAcquireLicense: boolean;
  theme: ThemeType;
  setAutoFetchVersionInfo: (enabled: boolean) => void;
  setAutoAcquireLicense: (enabled: boolean) => void;
  setTheme: (theme: ThemeType) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoFetchVersionInfo: true,
      autoAcquireLicense: true,
      theme: "light",
      setAutoFetchVersionInfo: (enabled) =>
        set({ autoFetchVersionInfo: enabled }),
      setAutoAcquireLicense: (enabled) => set({ autoAcquireLicense: enabled }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "asspp-settings",
      version: 2,
      // v0 stored the search entity and v1 the default country/platform; the search
      // page keeps its own last-used pair now, so these are dropped, not migrated.
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        delete state.defaultEntity;
        delete state.defaultCountry;
        delete state.defaultPlatform;
        return state as unknown as SettingsState;
      },
    },
  ),
);
