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
  app.use(express.json());
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

  afterAll(async () => {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
          source: "package",
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain("seededAt");
  });

  it("saves client metadata for a version", async () => {
    const res = await request(createApp())
      .put("/api/version-metadata/6503940939/900000001")
      .send({
        displayVersion: "2.0.0",
        releaseDate: "2026-08-01T00:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      saved: true,
      entry: {
        versionId: "900000001",
        displayVersion: "2.0.0",
        releaseDate: "2026-08-01T00:00:00.000Z",
        source: "client",
      },
    });

    const list = await request(createApp()).get(
      "/api/version-metadata/6503940939",
    );
    expect(list.body.entries).toHaveLength(2);
  });

  it("declines to displace a package entry, returning it instead", async () => {
    const res = await request(createApp())
      .put("/api/version-metadata/6503940939/888154622")
      .send({
        displayVersion: "0.0.1",
        releaseDate: "2020-01-01T00:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.entry.displayVersion).toBe("1.3.18");
  });

  it("validates ids and payloads", async () => {
    const badApp = await request(createApp())
      .put("/api/version-metadata/abc/1")
      .send({ displayVersion: "1", releaseDate: "d" });
    expect(badApp.status).toBe(400);

    const badVersion = await request(createApp())
      .put("/api/version-metadata/1/x")
      .send({ displayVersion: "1", releaseDate: "d" });
    expect(badVersion.status).toBe(400);

    const missingBody = await request(createApp())
      .put("/api/version-metadata/1/2")
      .send({});
    expect(missingBody.status).toBe(400);

    const blankValue = await request(createApp())
      .put("/api/version-metadata/1/2")
      .send({ displayVersion: "", releaseDate: "d" });
    expect(blankValue.status).toBe(400);
  });

  describe("POST /api/version-metadata/:appId/:versionId/package (client write-back)", () => {
    // The download URL in the request body is fetched by the server only when
    // it passes the same allowlist as every package address — otherwise the
    // route refuses it. Each of these is rejected in `validateDownloadURL`
    // before any network connection is made, so they run offline.
    const cases: Array<[string, string]> = [
      ["non-HTTPS", "http://example.com/app.ipa"],
      ["non-Apple host", "https://evil.example.com/app.ipa"],
      ["plain IP", "https://93.184.216.34/app.ipa"],
      ["IPv6 literal", "https://[::1]/app.ipa"],
    ];

    for (const [label, downloadURL] of cases) {
      it(`refuses a ${label} download URL`, async () => {
        const res = await request(createApp())
          .post("/api/version-metadata/6503940939/888154622/package")
          .send({ downloadURL });
        expect(res.status).toBe(502);
        expect(typeof res.body.error).toBe("string");
      });
    }
  });
});
