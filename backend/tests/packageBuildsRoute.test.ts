import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import type { Software } from "../src/types/index.js";

// Keep the index's database out of the real data directory.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "package-builds-route-"));
process.env.DATA_DIR = TEMP_DIR;

const packageBuildRoutes = (await import("../src/routes/packageBuilds.js"))
  .default;
const store = await import("../src/services/packageAppStore.js");

function software(overrides: Partial<Software>): Software {
  return {
    id: 6503940939,
    bundleID: "flux.inchmade.app",
    name: "Forward",
    version: "1.3.18",
    artistName: "宋帅 郑",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "17.0",
    releaseDate: "",
    primaryGenreName: "Entertainment",
    ...overrides,
  } as Software;
}

function createApp() {
  const app = express();
  app.use("/api", packageBuildRoutes);
  return app;
}

describe("Package Builds Route", () => {
  beforeAll(() => {
    store.rememberPackageApp(
      software({ platform: "tvos", version: "1.3.18", externalVersionId: "888154623" }),
    );
    // An iOS package compiled before the id was recorded: its build has no id,
    // which the route must report as absent rather than invent one.
    store.rememberPackageApp(
      software({ platform: "ios", version: "1.3.18", externalVersionId: "" }),
    );
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("returns an empty list for an app the index has never seen", async () => {
    const res = await request(createApp()).get("/api/package-builds/123456");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ builds: [] });
  });

  it("rejects a non-numeric app id", async () => {
    const res = await request(createApp()).get("/api/package-builds/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid app id");
  });

  it("lists every build per platform, with the id the package carried", async () => {
    // A caller ruling out other platforms' builds needs all of them — the pin
    // store only keeps the newest per platform.
    const res = await request(createApp()).get("/api/package-builds/6503940939");
    expect(res.status).toBe(200);

    const builds = res.body.builds as Array<{
      platform?: string;
      versionId?: string;
      version?: string;
    }>;
    expect(builds).toHaveLength(2);
    expect(
      builds.find((build) => build.platform === "tvos"),
    ).toMatchObject({ versionId: "888154623", version: "1.3.18" });
    expect(
      builds.find((build) => build.platform === "ios"),
    ).toMatchObject({ version: "1.3.18" });
    expect(
      builds.find((build) => build.platform === "ios")?.versionId,
    ).toBeUndefined();
  });
});
