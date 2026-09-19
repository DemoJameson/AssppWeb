import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";

// Keep the store's persist file out of the real data directory.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "version-pins-route-"));
process.env.DATA_DIR = TEMP_DIR;

const versionPinRoutes = (await import("../src/routes/versionPins.js")).default;
const store = await import("../src/services/versionPinStore.js");

function createApp() {
  const app = express();
  app.use("/api", versionPinRoutes);
  return app;
}

describe("Version Pins Route", () => {
  beforeAll(() => {
    store.initVersionPinStore();
    store.recordVersionPin(6503940939, "tvos", "888154622");
    store.recordVersionPin(6503940939, "macos", "700000001");
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("returns an empty list for an app with no recorded pins", async () => {
    const res = await request(createApp()).get("/api/version-pins/123456");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pins: [] });
  });

  it("rejects a non-numeric app id", async () => {
    const res = await request(createApp()).get("/api/version-pins/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid app id");
  });

  it("returns the recorded pins for an app, public fields only", async () => {
    const res = await request(createApp()).get("/api/version-pins/6503940939");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pins: [
        { platform: "macos", versionId: "700000001" },
        { platform: "tvos", versionId: "888154622" },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain("updatedAt");
  });
});
