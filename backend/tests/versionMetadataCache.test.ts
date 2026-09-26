import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { PackageMetadata } from "../src/services/sinfInjector.js";

// Isolate the cache (and its DB) to a scratch directory before the service —
// and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "version-metadata-cache-"));
process.env.DATA_DIR = TEMP_DIR;
// Small cap so the eviction test needs only a handful of entries.
process.env.VERSION_METADATA_MAX_ENTRIES = "3";

const cache = await import("../src/services/versionMetadataCache.js");

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

  afterAll(async () => {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
        source: "package",
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

  it("persists to SQLite and reloads on restart", async () => {
    const dbPath = path.join(TEMP_DIR, "asspp.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Simulate a restart: close the handle (the DB file persists) and reset the
    // cache so it re-prepars its statements against the reopened connection.
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    cache.resetVersionMetadataCacheForTest();
    cache.initVersionMetadataCache();
    expect(cache.getVersionMetadataForApp(6503940939)).toHaveLength(3);
  });

  it("saves client metadata and refreshes it on later saves", () => {
    const clientApp = 785858585;
    expect(
      cache.saveClientVersionMetadata(
        clientApp,
        "5001",
        "5.0.0",
        "2026-02-02T00:00:00.000Z",
      ).saved,
    ).toBe(true);
    expect(cache.getVersionMetadataForApp(clientApp)).toEqual([
      {
        versionId: "5001",
        displayVersion: "5.0.0",
        releaseDate: "2026-02-02T00:00:00.000Z",
        source: "client",
      },
    ]);

    expect(
      cache.saveClientVersionMetadata(
        clientApp,
        "5001",
        "5.0.1",
        "2026-02-03T00:00:00.000Z",
      ).saved,
    ).toBe(true);
    expect(cache.getVersionMetadataForApp(clientApp)[0].displayVersion).toBe(
      "5.0.1",
    );
  });

  it("rejects invalid client payloads", () => {
    expect(cache.saveClientVersionMetadata("abc", "1", "v", "d").saved).toBe(
      false,
    );
    expect(cache.saveClientVersionMetadata(1, "x", "v", "d").saved).toBe(false);
    expect(cache.saveClientVersionMetadata(1, "2", "", "d").saved).toBe(false);
    expect(cache.saveClientVersionMetadata(1, "2", "v", undefined).saved).toBe(
      false,
    );
  });

  it("lets a package seed replace a client entry, and refuses the reverse", () => {
    const clientApp = 785858585;
    cache.seedVersionMetadata(
      clientApp,
      pkg({
        externalVersionId: "5001",
        version: "9.9.9",
        releaseDate: "2026-03-03T00:00:00.000Z",
      }),
    );
    expect(cache.getVersionMetadataForApp(clientApp)[0].displayVersion).toBe(
      "9.9.9",
    );

    const rejected = cache.saveClientVersionMetadata(
      clientApp,
      "5001",
      "1.1.1",
      "2026-01-01T00:00:00.000Z",
    );
    expect(rejected.saved).toBe(false);
    expect(rejected.entry?.displayVersion).toBe("9.9.9");
    expect(cache.getVersionMetadataForApp(clientApp)[0].displayVersion).toBe(
      "9.9.9",
    );
  });

  it("persists the source alongside each entry", async () => {
    const clientApp = 785858585;
    cache.saveClientVersionMetadata(
      clientApp,
      "5002",
      "6.0.0",
      "2026-04-04T00:00:00.000Z",
    );

    // Read straight from the DB to verify the source column.
    const { getDb } = await import("../src/services/db.js");
    const db = getDb();
    const rows = db
      .prepare("SELECT version_id, source FROM version_metadata WHERE app_id = ?")
      .all(clientApp) as Array<{ version_id: number; source: string }>;
    const byVersion = new Map(rows.map((r) => [String(r.version_id), r.source]));
    expect(byVersion.get("5001")).toBe("package");
    expect(byVersion.get("5002")).toBe("client");
  });

  /**
   * The write behind `POST /version-metadata/:appId/:versionId/package`. The
   * date did come out of a package, so it is displayable; the URL was the
   * client's, so it is not the pipeline's own record.
   */
  describe("savePackageReadVersionMetadata", () => {
    const readApp = 909090909;

    it("stores a package-read entry and refreshes it on a later read", () => {
      expect(
        cache.savePackageReadVersionMetadata(
          readApp,
          "7001",
          "7.0.0",
          "2026-05-05T00:00:00.000Z",
        ).saved,
      ).toBe(true);
      expect(cache.getVersionMetadataForApp(readApp)).toEqual([
        {
          versionId: "7001",
          displayVersion: "7.0.0",
          releaseDate: "2026-05-05T00:00:00.000Z",
          source: "package-read",
        },
      ]);

      expect(
        cache.savePackageReadVersionMetadata(
          readApp,
          "7001",
          "7.0.1",
          "2026-05-06T00:00:00.000Z",
        ).saved,
      ).toBe(true);
      expect(cache.getVersionMetadataForApp(readApp)[0].displayVersion).toBe(
        "7.0.1",
      );
    });

    it("outranks a client entry, and is not displaced by one", () => {
      cache.saveClientVersionMetadata(
        readApp,
        "7002",
        "1.0.0",
        "2026-01-01T00:00:00.000Z",
      );
      expect(
        cache.savePackageReadVersionMetadata(
          readApp,
          "7002",
          "2.0.0",
          "2026-02-02T00:00:00.000Z",
        ).saved,
      ).toBe(true);
      expect(
        cache
          .getVersionMetadataForApp(readApp)
          .find((entry) => entry.versionId === "7002")?.source,
      ).toBe("package-read");

      // Apple's app-level date must not overwrite a build's own.
      const declined = cache.saveClientVersionMetadata(
        readApp,
        "7002",
        "3.0.0",
        "2026-03-03T00:00:00.000Z",
      );
      expect(declined.saved).toBe(false);
      expect(declined.entry?.displayVersion).toBe("2.0.0");
      expect(declined.entry?.source).toBe("package-read");
    });

    it("cannot displace what the download pipeline compiled", () => {
      const compiled = 909090910;
      cache.seedVersionMetadata(
        compiled,
        pkg({ externalVersionId: "8001", version: "8.0.0" }),
      );

      const declined = cache.savePackageReadVersionMetadata(
        compiled,
        "8001",
        "0.0.1",
        "2020-01-01T00:00:00.000Z",
      );
      expect(declined.saved).toBe(false);
      expect(declined.entry?.source).toBe("package");
      expect(declined.entry?.displayVersion).toBe("8.0.0");
    });
  });
});
