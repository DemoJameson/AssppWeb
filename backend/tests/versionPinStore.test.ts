import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate the store (and its persist file) to a scratch directory before the
// service — and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "version-pins-"));
process.env.DATA_DIR = TEMP_DIR;

const store = await import("../src/services/versionPinStore.js");
const PINS_FILE = path.join(TEMP_DIR, "version-pins.json");

describe("versionPinStore", () => {
  beforeAll(() => {
    store.initVersionPinStore();
  });

  afterAll(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
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

  it("persists to DATA_DIR/version-pins.json and reloads on restart", async () => {
    const raw = JSON.parse(fs.readFileSync(PINS_FILE, "utf-8")) as {
      schema: number;
      pins: Record<string, Record<string, { versionId: string }>>;
    };
    expect(raw.schema).toBe(1);
    expect(raw.pins["6503940939"]["tvos"].versionId).toBe("888154700");

    // Simulate a restart: fresh module graph reads the persisted file.
    vi.resetModules();
    const reloaded = await import("../src/services/versionPinStore.js");
    reloaded.initVersionPinStore();
    expect(reloaded.getVersionPinsForApp(6503940939)).toEqual([
      { platform: "tvos", versionId: "888154700" },
    ]);
  });

  it("tolerates a corrupted store file", async () => {
    fs.writeFileSync(PINS_FILE, "{not json");

    vi.resetModules();
    const fresh = await import("../src/services/versionPinStore.js");
    fresh.initVersionPinStore();
    expect(fresh.getVersionPinsForApp(6503940939)).toEqual([]);

    // Recording still works after starting fresh from a bad file.
    fresh.recordVersionPin(6503940939, "macos", "700000001");
    expect(fresh.getVersionPinsForApp(6503940939)).toEqual([
      { platform: "macos", versionId: "700000001" },
    ]);
  });
});
