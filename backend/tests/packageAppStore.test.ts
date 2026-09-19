import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Software } from "../src/types/index.js";

// Isolate the store (and its persist file) to a scratch directory before the
// service — and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "package-apps-"));
process.env.DATA_DIR = TEMP_DIR;

const store = await import("../src/services/packageAppStore.js");
const APPS_FILE = path.join(TEMP_DIR, "package-apps.json");

function software(overrides: Partial<Software> = {}): Software {
  return {
    id: 6503940939,
    bundleID: "com.example.legacy",
    name: "Legacy App",
    version: "4.8.2",
    artistName: "Old Software",
    sellerName: "Old Software",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "https://is1-ssl.mzstatic.com/icon.png",
    screenshotUrls: [],
    minimumOsVersion: "15.0",
    releaseDate: "",
    primaryGenreName: "Utilities",
    platform: "ios",
    ...overrides,
  } as Software;
}

describe("packageAppStore", () => {
  beforeAll(() => {
    store.initPackageAppStore();
  });

  afterEach(() => {
    // A changed record now schedules a debounced write; clear any pending timer
    // so it cannot fire into the next test's assertions.
    store.flushPackageAppStore();
  });

  afterAll(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it("skips records without a numeric app id or a bundle id", () => {
    store.rememberPackageApp(software({ id: Number.NaN }));
    store.rememberPackageApp(software({ id: 42, bundleID: "  " }));
    expect(store.findPackageAppByAppId(42)).toBeUndefined();
    expect(store.findPackageAppByAppId(6503940939)).toBeUndefined();
  });

  it("records a package's app and finds it by bundle id (any case) and id", () => {
    store.rememberPackageApp(software());

    const byBundle = store.findPackageAppByBundleId("COM.Example.Legacy");
    expect(byBundle?.appId).toBe("6503940939");
    expect(byBundle?.name).toBe("Legacy App");
    expect(byBundle?.primaryGenreName).toBe("Utilities");
    expect(byBundle?.builds.ios?.version).toBe("4.8.2");

    const byId = store.findPackageAppByAppId("6503940939");
    expect(byId?.bundleID).toBe("com.example.legacy");
  });

  it("keeps per-platform builds apart and never passes one for another", () => {
    store.rememberPackageApp(
      software({ platform: "tvos", version: "4.9.1", minimumOsVersion: "17.0" }),
    );

    const record = store.findPackageAppByAppId(6503940939);
    expect(record?.builds.ios?.version).toBe("4.8.2");
    expect(record?.builds.tvos?.version).toBe("4.9.1");

    // The lookup answers with the requested platform's build...
    expect(store.buildForPlatform(record, "ios")?.version).toBe("4.8.2");
    expect(store.buildForPlatform(record, "tvos")?.version).toBe("4.9.1");
    // ...and with nothing when that platform has no recorded package.
    expect(store.buildForPlatform(record, "macos")).toBeUndefined();
    // Without a requested platform, any build will do.
    expect(store.buildForPlatform(record)).toBeTruthy();
  });

  it("does not let the bare-id placeholder overwrite a real name", () => {
    store.rememberPackageApp(software({ name: "App 6503940939" }));
    expect(store.findPackageAppByAppId(6503940939)?.name).toBe("Legacy App");
  });

  it("keeps existing values when a later read has gaps", () => {
    store.rememberPackageApp(
      software({
        artistName: "",
        primaryGenreName: "",
        version: "",
        minimumOsVersion: "",
      }),
    );
    const record = store.findPackageAppByAppId(6503940939);
    expect(record?.artistName).toBe("Old Software");
    expect(record?.primaryGenreName).toBe("Utilities");
    expect(record?.builds.ios?.version).toBe("4.8.2");
    expect(record?.builds.ios?.minimumOsVersion).toBe("15.0");
  });

  it("skips the rewrite when a fresh read carries nothing new", () => {
    const spy = vi.spyOn(fs, "writeFileSync");

    store.rememberPackageApp(software());
    expect(spy).not.toHaveBeenCalled();

    store.rememberPackageApp(software({ version: "4.9.0" }));
    // The write is debounced; nothing lands until the timer is flushed.
    expect(spy).not.toHaveBeenCalled();

    store.flushPackageAppStore();
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("persists per-platform builds and reloads them on restart", async () => {
    store.rememberPackageApp(software({ platform: "tvos", version: "4.9.1" }));
    store.flushPackageAppStore();

    const raw = JSON.parse(fs.readFileSync(APPS_FILE, "utf-8")) as {
      schema: number;
      apps: Record<string, { bundleID: string; builds: Record<string, unknown> }>;
    };
    expect(raw.schema).toBe(2);
    expect(raw.apps["6503940939"].bundleID).toBe("com.example.legacy");
    expect(Object.keys(raw.apps["6503940939"].builds).sort()).toEqual([
      "ios",
      "tvos",
    ]);

    // Simulate a restart: fresh module graph reads the persisted file.
    vi.resetModules();
    const reloaded = await import("../src/services/packageAppStore.js");
    reloaded.initPackageAppStore();
    const record = reloaded.findPackageAppByBundleId("com.example.legacy");
    expect(record?.builds.tvos?.version).toBe("4.9.1");
    expect(record?.builds.ios?.version).toBe("4.9.0");
  });

  it("migrates legacy flat records (schema 1) into per-platform builds", async () => {
    fs.writeFileSync(
      APPS_FILE,
      JSON.stringify({
        schema: 1,
        apps: {
          "6503940939": {
            bundleID: "com.example.legacy",
            name: "Legacy App",
            version: "1.3.19",
            minimumOsVersion: "17.0",
            platform: "tvos",
            updatedAt: 1,
          },
        },
      }),
    );

    vi.resetModules();
    const fresh = await import("../src/services/packageAppStore.js");
    fresh.initPackageAppStore();

    const record = fresh.findPackageAppByBundleId("com.example.legacy");
    expect(record?.name).toBe("Legacy App");
    expect(fresh.buildForPlatform(record, "tvos")?.version).toBe("1.3.19");
    // The old record was a tvOS one; iOS must not inherit its version.
    expect(fresh.buildForPlatform(record, "ios")).toBeUndefined();
  });

  it("tolerates a corrupted store file", async () => {
    fs.writeFileSync(APPS_FILE, "{not json");

    vi.resetModules();
    const fresh = await import("../src/services/packageAppStore.js");
    fresh.initPackageAppStore();
    expect(fresh.findPackageAppByAppId(6503940939)).toBeUndefined();
  });

  it("coalesces a burst of records into a single write", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(fs, "writeFileSync");
      const freshId = 4242424242;

      store.rememberPackageApp(
        software({ id: freshId, bundleID: "com.example.coalesce", version: "1.0.0" }),
      );
      store.rememberPackageApp(
        software({ id: freshId, bundleID: "com.example.coalesce", version: "1.0.1" }),
      );
      store.rememberPackageApp(
        software({ id: freshId, bundleID: "com.example.coalesce", version: "1.0.2" }),
      );

      // The debounce window has not elapsed: nothing has been written yet.
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(spy).toHaveBeenCalledTimes(1);

      const raw = JSON.parse(fs.readFileSync(APPS_FILE, "utf-8")) as {
        apps: Record<string, { builds: Record<string, { version?: string }> }>;
      };
      // The single write carries the final state, not an intermediate one.
      expect(raw.apps[String(freshId)].builds.ios.version).toBe("1.0.2");
    } finally {
      vi.useRealTimers();
    }
  });
});
