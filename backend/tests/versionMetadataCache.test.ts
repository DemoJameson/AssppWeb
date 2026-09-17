import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { PackageMetadata } from "../src/services/sinfInjector.js";

// Isolate the cache (and its persist file) to a scratch directory before the
// service — and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "version-metadata-cache-"));
process.env.DATA_DIR = TEMP_DIR;
// Small cap so the eviction test needs only a handful of entries.
process.env.VERSION_METADATA_MAX_ENTRIES = "3";

const cache = await import("../src/services/versionMetadataCache.js");
const CACHE_FILE = path.join(TEMP_DIR, "version-metadata.json");

function pkg(overrides: Partial<PackageMetadata> = {}): PackageMetadata {
  return {
    version: "1.0.0",
    releaseDate: "2026-01-01T00:00:00.000Z",
    externalVersionId: "1001",
    ...overrides,
  };
}

describe("versionMetadataCache", () => {
  beforeAll(() => {
    cache.initVersionMetadataCache();
  });

  afterAll(() => {
    cache.flushVersionMetadataCache();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it("rejects seeds without numeric app or version ids", () => {
    cache.seedVersionMetadata("abc", pkg());
    cache.seedVersionMetadata(6503940939, pkg({ externalVersionId: "x1" }));
    cache.seedVersionMetadata(6503940939, pkg({ externalVersionId: undefined }));
    expect(cache.getVersionMetadataForApp(6503940939)).toHaveLength(0);
  });

  it("rejects seeds missing a display field", () => {
    cache.seedVersionMetadata(6503940939, pkg({ version: undefined }));
    cache.seedVersionMetadata(6503940939, pkg({ releaseDate: "  " }));
    cache.seedVersionMetadata(6503940939, pkg({ version: "v".repeat(65) }));
    expect(cache.getVersionMetadataForApp(6503940939)).toHaveLength(0);
  });

  it("stores and returns entries addressed by the numeric app id", () => {
    cache.seedVersionMetadata(6503940939, pkg());
    expect(cache.getVersionMetadataForApp("6503940939")).toEqual([
      {
        versionId: "1001",
        displayVersion: "1.0.0",
        releaseDate: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("is write-once per (app, version): re-seeding never changes the entry", () => {
    cache.seedVersionMetadata(6503940939, pkg({ version: "9.9.9" }));
    const [entry] = cache.getVersionMetadataForApp(6503940939);
    expect(entry.displayVersion).toBe("1.0.0");
    expect(cache.getVersionMetadataForApp(6503940939)).toHaveLength(1);
  });

  it("evicts the oldest entries once the cap is exceeded", () => {
    cache.seedVersionMetadata(6503940939, pkg({ externalVersionId: "1002", version: "1.0.1" }));
    cache.seedVersionMetadata(6503940939, pkg({ externalVersionId: "1003", version: "1.0.2" }));
    // The cap is 3; seeding a fourth version must evict the oldest (1001).
    cache.seedVersionMetadata(6503940939, pkg({ externalVersionId: "1004", version: "1.0.3" }));
    const versions = cache
      .getVersionMetadataForApp(6503940939)
      .map((entry) => entry.versionId);
    expect(versions).toEqual(["1002", "1003", "1004"]);
  });

  it("persists to DATA_DIR/version-metadata.json and reloads on restart", async () => {
    cache.flushVersionMetadataCache();

    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as {
      schema: number;
      entries: Record<string, Record<string, { displayVersion: string }>>;
    };
    expect(raw.schema).toBe(1);
    expect(raw.entries["6503940939"]["1004"].displayVersion).toBe("1.0.3");

    // Simulate a restart: fresh module graph reads the persisted file.
    vi.resetModules();
    const reloaded = await import("../src/services/versionMetadataCache.js");
    reloaded.initVersionMetadataCache();
    expect(reloaded.getVersionMetadataForApp(6503940939)).toHaveLength(3);
    reloaded.flushVersionMetadataCache();
  });

  it("tolerates a corrupted cache file", async () => {
    fs.writeFileSync(CACHE_FILE, "{not json");

    vi.resetModules();
    const fresh = await import("../src/services/versionMetadataCache.js");
    fresh.initVersionMetadataCache();
    expect(fresh.getVersionMetadataForApp(6503940939)).toEqual([]);

    // Seeding still works after starting fresh from a bad file.
    fresh.seedVersionMetadata(
      6503940939,
      pkg({ externalVersionId: "2001", version: "2.0.0" }),
    );
    expect(fresh.getVersionMetadataForApp(6503940939)).toHaveLength(1);
    fresh.flushVersionMetadataCache();
  });
});
