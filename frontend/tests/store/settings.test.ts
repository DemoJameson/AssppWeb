import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/store/settings";

function migrate() {
  return (
    useSettingsStore.persist as unknown as {
      getOptions: () => {
        migrate?: (state: unknown, version: number) => unknown;
      };
    }
  ).getOptions().migrate!;
}

describe("store/settings", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the zustand store
    useSettingsStore.setState({
      autoFetchVersionInfo: true,
      autoAcquireLicense: true,
    });
  });

  it("enables the automation switches by default", () => {
    expect(useSettingsStore.getState().autoFetchVersionInfo).toBe(true);
    expect(useSettingsStore.getState().autoAcquireLicense).toBe(true);
  });

  it("toggles the automation switches", () => {
    useSettingsStore.getState().setAutoFetchVersionInfo(false);
    useSettingsStore.getState().setAutoAcquireLicense(false);
    expect(useSettingsStore.getState().autoFetchVersionInfo).toBe(false);
    expect(useSettingsStore.getState().autoAcquireLicense).toBe(false);
  });

  it("drops the retired default country and platform on migration", () => {
    // v1 kept them here; the search page holds its own last-used pair now.
    const migrated = migrate()({
      defaultCountry: "GB",
      defaultPlatform: "ipad",
      autoFetchVersionInfo: false,
      theme: "dark",
    }) as Record<string, unknown>;

    expect(migrated.defaultCountry).toBeUndefined();
    expect(migrated.defaultPlatform).toBeUndefined();
    // Everything the store still owns survives.
    expect(migrated.autoFetchVersionInfo).toBe(false);
    expect(migrated.theme).toBe("dark");
  });

  it("drops the v0 entity preference too", () => {
    const migrated = migrate()({ defaultEntity: "iPad" }) as Record<
      string,
      unknown
    >;

    expect(migrated.defaultEntity).toBeUndefined();
  });
});
