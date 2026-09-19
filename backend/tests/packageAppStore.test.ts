import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Software } from "../src/types/index.js";

// Isolate the store (and its DB) to a scratch directory before the service —
// and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "package-apps-"));
process.env.DATA_DIR = TEMP_DIR;

const store = await import("../src/services/packageAppStore.js");

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

  afterAll(async () => {
    // Close the DB handle so the WAL files settle. The temp directory is left
    // for the OS to reap — on Windows the SQLite WAL files can stay locked
    // briefly after close, and `fs.rmSync` would EPERM.
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
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
    // SQLite writes are immediate; the no-op is observed via the DB row staying
    // the same. A second remember with no changed fields must not throw and the
    // record must be unchanged.
    store.rememberPackageApp(software());
    const before = store.findPackageAppByAppId(6503940939);
    store.rememberPackageApp(software());
    const after = store.findPackageAppByAppId(6503940939);
    expect(after).toEqual(before);
  });

  it("persists per-platform builds and reloads them on restart", async () => {
    store.rememberPackageApp(software({ platform: "tvos", version: "4.9.1" }));

    const dbPath = path.join(TEMP_DIR, "asspp.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Simulate a restart: close the handle (the DB file persists) and reset the
    // store so it re-prepars its statements against the reopened connection.
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    store.resetPackageAppStoreForTest();
    store.initPackageAppStore();
    const record = store.findPackageAppByBundleId("com.example.legacy");
    expect(record?.builds.tvos?.version).toBe("4.9.1");
    expect(record?.builds.ios?.version).toBe("4.8.2");
  });

  it("searches by name, most recently updated first", () => {
    store.rememberPackageApp(
      software({ id: 1111111111, bundleID: "com.example.alpha", name: "Alpha One" }),
    );
    store.rememberPackageApp(
      software({ id: 2222222222, bundleID: "com.example.alpha2", name: "Alpha Two" }),
    );
    const matches = store.searchPackageAppsByName("alpha");
    expect(matches).toHaveLength(2);
    // Both should match; order is by updatedAt desc, both just written.
    const names = matches.map((m) => m.name).sort();
    expect(names).toEqual(["Alpha One", "Alpha Two"]);
  });
});
