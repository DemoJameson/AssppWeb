import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import type { PackageMetadata } from "../src/services/sinfInjector.js";

// Keep the service's persist file out of the real data directory.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "version-metadata-route-"));
process.env.DATA_DIR = TEMP_DIR;

const versionMetadataRoutes = (
  await import("../src/routes/versionMetadata.js")
).default;
const cache = await import("../src/services/versionMetadataCache.js");

function createApp() {
  const app = express();
  app.use("/api", versionMetadataRoutes);
  return app;
}

describe("Version Metadata Route", () => {
  beforeAll(() => {
    cache.initVersionMetadataCache();
    cache.seedVersionMetadata(6503940939, {
      version: "1.3.18",
      releaseDate: "2026-07-11T15:06:44.000Z",
      externalVersionId: "888154622",
    } satisfies PackageMetadata);
  });

  afterAll(() => {
    cache.flushVersionMetadataCache();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it("returns an empty list for an app with no cached versions", async () => {
    const res = await request(createApp()).get("/api/version-metadata/123456");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it("rejects a non-numeric app id", async () => {
    const res = await request(createApp()).get("/api/version-metadata/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid app id");
  });

  it("returns the cached entries for a seeded app, public fields only", async () => {
    const res = await request(createApp()).get(
      "/api/version-metadata/6503940939",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entries: [
        {
          versionId: "888154622",
          displayVersion: "1.3.18",
          releaseDate: "2026-07-11T15:06:44.000Z",
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain("seededAt");
  });
});
