import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/store/settings";

describe("store/settings", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the zustand store
    useSettingsStore.setState({
      defaultCountry: "US",
      defaultPlatform: "ios",
      defaultAccount: "",
      autoFetchVersionInfo: true,
      autoAcquireLicense: true,
    });
  });

  it("should have default country US", () => {
    const state = useSettingsStore.getState();
    expect(state.defaultCountry).toBe("US");
  });

  it("should default to the iOS platform", () => {
    const state = useSettingsStore.getState();
    expect(state.defaultPlatform).toBe("ios");
  });

  it("should update default country", () => {
    useSettingsStore.getState().setDefaultCountry("GB");
    expect(useSettingsStore.getState().defaultCountry).toBe("GB");
  });

  it("should update default platform", () => {
    useSettingsStore.getState().setDefaultPlatform("tvos");
    expect(useSettingsStore.getState().defaultPlatform).toBe("tvos");
  });

  it("should default to no remembered account", () => {
    expect(useSettingsStore.getState().defaultAccount).toBe("");
  });

  it("should remember the selected account", () => {
    useSettingsStore.getState().setDefaultAccount("dev@example.test");
    expect(useSettingsStore.getState().defaultAccount).toBe("dev@example.test");
  });

  it("should enable the automation switches by default", () => {
    expect(useSettingsStore.getState().autoFetchVersionInfo).toBe(true);
    expect(useSettingsStore.getState().autoAcquireLicense).toBe(true);
  });

  it("should toggle the automation switches", () => {
    useSettingsStore.getState().setAutoFetchVersionInfo(false);
    useSettingsStore.getState().setAutoAcquireLicense(false);
    expect(useSettingsStore.getState().autoFetchVersionInfo).toBe(false);
    expect(useSettingsStore.getState().autoAcquireLicense).toBe(false);
  });

  it("should migrate the v0 entity preference to a platform", () => {
    // v0 persisted the search entity as "iPhone"/"iPad".
    localStorage.setItem(
      "asspp-settings",
      JSON.stringify({
        state: { defaultCountry: "GB", defaultEntity: "iPad" },
        version: 0,
      }),
    );

    // Rehydrate from storage: zustand merges on import time, so re-read by
    // dispatching through persist's API.
    const rehydrated = JSON.parse(localStorage.getItem("asspp-settings")!);

    // The migrate hook runs at store creation; simulate a fresh reader by
    // asserting the migration logic through the store's persist API.
    const migrated = (
      useSettingsStore.persist as unknown as {
        getOptions: () => {
          migrate?: (state: unknown, version: number) => unknown;
        };
      }
    ).getOptions().migrate!(rehydrated.state, 0) as Record<string, unknown>;

    expect(migrated.defaultPlatform).toBe("ipad");
    expect(migrated.defaultEntity).toBeUndefined();
  });

  it("should keep an unknown platform on iOS after migration", () => {
    const migrated = (
      useSettingsStore.persist as unknown as {
        getOptions: () => {
          migrate?: (state: unknown, version: number) => unknown;
        };
      }
    ).getOptions().migrate!({ defaultCountry: "US" }, 0) as Record<
      string,
      unknown
    >;

    expect(migrated.defaultPlatform).toBe("ios");
  });
});
