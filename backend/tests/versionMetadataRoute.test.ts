import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
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

  describe("POST /api/version-metadata/:appId/:versionId/package (what it stores)", () => {
    /**
     * The route reads a package at a URL the *client* named, so whatever it
     * learns has to stay a client entry: refreshable, and unable to pose as the
     * download pipeline's own compile. The alternative — a client-writable
     * `package` entry — is a permanent, unoverwritable claim about any
     * (app, version) pair, which any caller of the instance could plant.
     */
    const APP = 6503940940;
    /** Seeded as if the pipeline had compiled it; the route must not displace it. */
    const COMPILED_VERSION = "111111";
    const LOOKED_UP_VERSION = "222222";
    const SERVED_AT = new Date("2026-07-11T15:06:44Z");

    /** A one-entry zip holding the app's Info.plist, served as byte ranges. */
    function zipWithVersion(version: string, at: Date): Buffer {
      const name = Buffer.from("Payload/App.app/Info.plist", "utf8");
      const data = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>` +
          `<key>CFBundleShortVersionString</key><string>${version}</string>` +
          `</dict></plist>`,
        "utf8",
      );
      const dosTime =
        ((at.getUTCHours() & 0x1f) << 11) |
        ((at.getUTCMinutes() & 0x3f) << 5) |
        (Math.floor(at.getUTCSeconds() / 2) & 0x1f);
      const dosDate =
        (((at.getUTCFullYear() - 1980) & 0x7f) << 9) |
        (((at.getUTCMonth() + 1) & 0x0f) << 5) |
        (at.getUTCDate() & 0x1f);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 8); // stored, no compression
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(0, 42); // local header offset

      const body = Buffer.concat([local, name, data]);
      const directory = Buffer.concat([central, name]);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(directory.length, 12);
      eocd.writeUInt32LE(body.length, 16);

      return Buffer.concat([body, directory, eocd]);
    }

    let archive: Buffer;

    beforeEach(() => {
      archive = zipWithVersion("3.0.0", SERVED_AT);
      // The route's only network use: a HEAD for the size, then range reads of
      // the archive. Nothing here reaches Apple.
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(archive.length) },
          });
        }
        const range = String(
          (init?.headers as Record<string, string> | undefined)?.Range ?? "",
        );
        const match = /bytes=(\d+)-(\d+)/.exec(range);
        if (!match) return new Response(archive, { status: 200 });

        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), archive.length - 1);
        return new Response(archive.subarray(start, end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${archive.length}`,
          },
        });
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const readPackage = (versionId: string) =>
      request(createApp())
        .post(`/api/version-metadata/${APP}/${versionId}/package`)
        .send({ downloadURL: "https://example.apple.com/app.ipa" });

    it("stores what it reads as a package read, not as the pipeline's own compile", async () => {
      const res = await readPackage(LOOKED_UP_VERSION);
      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(true);
      // Displayable — the bytes came out of a package — but not authoritative:
      // the URL was the client's, so the server cannot attest the package.
      expect(res.body.entry.source).toBe("package-read");
      expect(res.body.entry.displayVersion).toBe("3.0.0");
      expect(res.body.entry.releaseDate).toBe("2026-07-11T15:06:44.000Z");

      const list = await request(createApp()).get(
        `/api/version-metadata/${APP}`,
      );
      const stored = list.body.entries.find(
        (entry: { versionId: string }) =>
          entry.versionId === LOOKED_UP_VERSION,
      );
      expect(stored.source).toBe("package-read");
    });

    it("lets a later read refresh an entry it wrote", async () => {
      await readPackage(LOOKED_UP_VERSION);

      archive = zipWithVersion("3.0.1", SERVED_AT);
      const res = await readPackage(LOOKED_UP_VERSION);

      expect(res.body.saved).toBe(true);
      expect(res.body.entry.displayVersion).toBe("3.0.1");
    });

    it("cannot displace what the download pipeline compiled", async () => {
      cache.seedVersionMetadata(APP, {
        version: "1.3.18",
        releaseDate: "2026-07-11T15:06:44.000Z",
        externalVersionId: COMPILED_VERSION,
      } satisfies PackageMetadata);

      const res = await readPackage(COMPILED_VERSION);

      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(false);
      expect(res.body.entry.source).toBe("package");
      expect(res.body.entry.displayVersion).toBe("1.3.18");
    });
  });
});
