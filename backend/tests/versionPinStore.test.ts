import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate the store (and its DB) to a scratch directory before the service —
// and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "version-pins-"));
process.env.DATA_DIR = TEMP_DIR;

const store = await import("../src/services/versionPinStore.js");

describe("versionPinStore", () => {
  beforeAll(() => {
    store.initVersionPinStore();
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("rejects invalid app ids, platforms and version ids", () => {
    store.recordVersionPin("abc", "tvos", "100");
    store.recordVersionPin(1, "windows", "100");
    store.recordVersionPin(1, "tvos", "x1");
    store.recordVersionPin(1, "tvos", undefined);
    expect(store.getVersionPinsForApp(1)).toEqual([]);
  });

  it("records a pin per app and platform", () => {
    store.recordVersionPin(6503940939, "tvos", "888154622");
    expect(store.getVersionPinsForApp("6503940939")).toEqual([
      { platform: "tvos", versionId: "888154622" },
    ]);
  });

  it("keeps the newest (largest) version id seen for a platform", () => {
    store.recordVersionPin(6503940939, "tvos", "888154600");
    store.recordVersionPin(6503940939, "tvos", "888154700");
    store.recordVersionPin(6503940939, "tvos", "888154650");
    expect(store.getVersionPinsForApp(6503940939)).toEqual([
      { platform: "tvos", versionId: "888154700" },
    ]);
  });

  it("defaults a missing platform to ios", () => {
    store.recordVersionPin(42, undefined, "5");
    expect(store.getVersionPinsForApp(42)).toEqual([
      { platform: "ios", versionId: "5" },
    ]);
  });

  it("persists to SQLite and reloads on restart", async () => {
    // The DB file exists and holds the rows written above.
    const dbPath = path.join(TEMP_DIR, "asspp.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Simulate a restart: close the handle (the DB file persists) and reset the
    // store so it re-prepars its statements against the reopened connection.
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    store.resetVersionPinStoreForTest();
    store.initVersionPinStore();
    expect(store.getVersionPinsForApp(6503940939)).toEqual([
      { platform: "tvos", versionId: "888154700" },
    ]);
  });

  it("continues recording after a restart", async () => {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    store.resetVersionPinStoreForTest();
    store.initVersionPinStore();
    store.recordVersionPin(6503940939, "macos", "700000001");
    const pins = store.getVersionPinsForApp(6503940939);
    // Ordered by platform: macos before tvos.
    expect(pins).toEqual([
      { platform: "macos", versionId: "700000001" },
      { platform: "tvos", versionId: "888154700" },
    ]);
  });
});
