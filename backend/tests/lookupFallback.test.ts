import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Software } from "../src/types/index.js";

// Isolate the package-app store (and its persist file) to a scratch directory
// before the service — and config.ts underneath it — are first imported.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-local-"));
process.env.DATA_DIR = TEMP_DIR;

const iTunesFetch = vi.fn();
vi.stubGlobal("fetch", iTunesFetch);

const searchRoutes = (await import("../src/routes/search.js")).default;
const store = await import("../src/services/packageAppStore.js");

function seedApp(overrides: Partial<Software> = {}) {
  store.rememberPackageApp({
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
  } as Software);
}

function replyWithJson(body: unknown) {
  iTunesFetch.mockResolvedValue({
    json: () => Promise.resolve(body),
  });
}

function createApp() {
  const app = express();
  app.use("/api", searchRoutes);
  return app;
}

afterEach(() => {
  iTunesFetch.mockReset();
});

describe("Lookup Route — package-app fallback", () => {
  const app = createApp();

  it("recalls a delisted app by bundle id when Apple knows nothing", async () => {
    seedApp();
    replyWithJson({ resultCount: 0, results: [] });

    const res = await request(app).get(
      "/api/lookup?bundleId=com.example.legacy&country=US&platform=ios",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 6503940939,
      bundleID: "com.example.legacy",
      name: "Legacy App",
      version: "4.8.2",
      artistName: "Old Software",
      primaryGenreName: "Utilities",
      platform: "ios",
      metadataSource: "local",
    });
  });

  it("recalls it by app id too, and matches bundle ids case-insensitively", async () => {
    replyWithJson({ resultCount: 0, results: [] });

    const byId = await request(app).get(
      "/api/lookup?id=6503940939&platform=ios",
    );
    expect(byId.body.metadataSource).toBe("local");
    expect(byId.body.name).toBe("Legacy App");

    const byCase = await request(app).get(
      "/api/lookup?bundleId=COM.EXAMPLE.LEGACY&platform=ios",
    );
    expect(byCase.body.id).toBe(6503940939);
  });

  it("never passes one platform's build for another platform's lookup", async () => {
    // `Forward` situation: only a tvOS package was ever recorded.
    seedApp({
      id: 1210000001,
      bundleID: "com.example.tronly",
      name: "TV Only",
      version: "9.9.9",
      platform: "tvos",
    });
    replyWithJson({ resultCount: 0, results: [] });

    const ios = await request(app).get(
      "/api/lookup?bundleId=com.example.tronly&platform=ios",
    );
    expect(ios.body.metadataSource).toBe("local");
    expect(ios.body.name).toBe("TV Only");
    // The tvOS version must not appear under an iOS lookup…
    expect(ios.body.version).toBe("");

    // …while the tvOS lookup still gets it.
    const tvos = await request(app).get(
      "/api/lookup?bundleId=com.example.tronly&platform=tvos",
    );
    expect(tvos.body.version).toBe("9.9.9");
  });

  it("stays null when neither Apple nor the index knows the app", async () => {
    replyWithJson({ resultCount: 0, results: [] });

    const res = await request(app).get("/api/lookup?bundleId=com.unknown.app");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("lets the storefront win over the local record", async () => {
    replyWithJson({
      resultCount: 1,
      results: [
        {
          trackId: 6503940939,
          bundleId: "com.example.legacy",
          trackName: "Legacy App",
          version: "9.9.9",
          artistName: "Old Software",
          formattedPrice: "Free",
        },
      ],
    });

    const res = await request(app).get(
      "/api/lookup?bundleId=com.example.legacy&platform=ios",
    );
    expect(res.body.version).toBe("9.9.9");
    expect(res.body.metadataSource).toBeUndefined();
  });
});
