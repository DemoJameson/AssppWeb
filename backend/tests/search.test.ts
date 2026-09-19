import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import searchRoutes from "../src/routes/search.js";
import {
  buildForPlatform,
  searchPackageAppsByName,
} from "../src/services/packageAppStore.js";

const iTunesFetch = vi.fn();
vi.stubGlobal("fetch", iTunesFetch);

// The package-app fallback must not depend on the developer's local data here;
// it is covered in lookupFallback.test.ts.
vi.mock("../src/services/packageAppStore.js", () => ({
  findPackageAppByBundleId: vi.fn(),
  findPackageAppByAppId: vi.fn(),
  searchPackageAppsByName: vi.fn(() => []),
  buildForPlatform: vi.fn(),
}));

const mockedSearchLocal = vi.mocked(searchPackageAppsByName);
const mockedBuildForPlatform = vi.mocked(buildForPlatform);

function createApp() {
  const app = express();
  app.use("/api", searchRoutes);
  return app;
}

const iTunesPayload = {
  resultCount: 1,
  results: [
    {
      trackId: 1492142120,
      bundleId: "com.example.utility",
      trackName: "Example Utility",
      version: "3.4.5",
      artistName: "Example Developer",
      sellerName: "Example Developer LLC",
      description: "A test application.",
      averageUserRating: 4.8,
      userRatingCount: 42,
      artworkUrl100: "https://is1-ssl.mzstatic.com/icon100.png",
      screenshotUrls: ["https://is1-ssl.mzstatic.com/shot.png"],
      minimumOsVersion: "16.0",
      fileSizeBytes: "5242880",
      currentVersionReleaseDate: "2026-08-01T00:00:00Z",
      formattedPrice: "Free",
      primaryGenreName: "Utilities",
    },
  ],
};

function replyWithJson(body: unknown, lookupBody?: unknown) {
  iTunesFetch.mockImplementation((url: string) =>
    Promise.resolve({
      json: () =>
        Promise.resolve(
          url.includes("/lookup") && lookupBody !== undefined
            ? lookupBody
            : body,
        ),
    }),
  );
}

afterEach(() => {
  iTunesFetch.mockReset();
  mockedSearchLocal.mockReset();
  mockedSearchLocal.mockReturnValue([]);
  mockedBuildForPlatform.mockReset();
});

describe("Search Route", () => {
  const app = createApp();

  it("GET /api/search forwards the query to iTunes without the platform", async () => {
    replyWithJson(iTunesPayload);

    const res = await request(app).get(
      "/api/search?term=utility&country=US&platform=macos&entity=macSoftware&limit=25",
    );

    expect(res.status).toBe(200);
    const requested = iTunesFetch.mock.calls[0][0] as string;
    const query = new URLSearchParams(requested.split("?")[1]);
    expect(query.get("term")).toBe("utility");
    expect(query.get("entity")).toBe("macSoftware");
    // The frontend-owned platform parameter must not reach Apple.
    expect(query.get("platform")).toBeNull();
  });

  it("GET /api/search stamps the chosen platform onto every result", async () => {
    replyWithJson(iTunesPayload);

    const res = await request(app).get("/api/search?term=utility&platform=macos");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1492142120);
    expect(res.body[0].platform).toBe("macos");
  });

  it("GET /api/search accepts ipatool's aliases", async () => {
    replyWithJson(iTunesPayload);

    const res = await request(app).get(
      "/api/search?term=utility&platform=AppleTV",
    );

    expect(res.status).toBe(200);
    expect(res.body[0].platform).toBe("tvos");
  });

  it("GET /api/search drops unknown platforms instead of forwarding them", async () => {
    replyWithJson(iTunesPayload);

    const res = await request(app).get(
      "/api/search?term=utility&platform=nonsense",
    );

    expect(res.status).toBe(200);
    const requested = iTunesFetch.mock.calls[0][0] as string;
    expect(
      new URLSearchParams(requested.split("?")[1]).get("platform"),
    ).toBeNull();
    expect(res.body[0].platform).toBeUndefined();
  });

  it("GET /api/search omits the platform field when none was requested", async () => {
    replyWithJson(iTunesPayload);

    const res = await request(app).get("/api/search?term=utility");

    expect(res.status).toBe(200);
    expect(res.body[0].platform).toBeUndefined();
  });

  it("GET /api/search merges delisted package-app matches into a name search", async () => {
    replyWithJson(iTunesPayload, { resultCount: 0, results: [] });
    mockedSearchLocal.mockReturnValue([
      {
        appId: "6503940939",
        bundleID: "flux.inchmade.app",
        name: "Forward",
        artistName: "Forward Team",
        builds: { ios: { version: "1.3.18", updatedAt: 5 } },
        updatedAt: 6,
      },
    ]);
    mockedBuildForPlatform.mockReturnValue({
      version: "1.3.18",
      minimumOsVersion: "17.0",
      updatedAt: 5,
    });

    const res = await request(app).get(
      "/api/search?term=Forward&country=US&entity=software&platform=ios",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: 6503940939,
      name: "Forward",
      version: "1.3.18",
      minimumOsVersion: "17.0",
      platform: "ios",
      metadataSource: "local",
    });
    // The catalogue results follow, untouched.
    expect(res.body[1].id).toBe(1492142120);
    expect(res.body[1].metadataSource).toBeUndefined();
  });

  it("GET /api/search re-checks local matches by bundle id and drops the local tag when the storefront still has the app", async () => {
    const storefrontForward = {
      trackId: 6503940939,
      bundleId: "flux.inchmade.app",
      trackName: "Forward",
      version: "1.3.19",
      artistName: "Forward Team",
      description: "Forward app",
      averageUserRating: 4.5,
      userRatingCount: 100,
      artworkUrl100: "https://icon.png",
      screenshotUrls: [],
      minimumOsVersion: "17.0",
      fileSizeBytes: "1000000",
      currentVersionReleaseDate: "2026-09-01T00:00:00Z",
      formattedPrice: "Free",
      primaryGenreName: "Utilities",
    };
    replyWithJson(
      { resultCount: 0, results: [] },
      { resultCount: 1, results: [storefrontForward] },
    );
    mockedSearchLocal.mockReturnValue([
      {
        appId: "6503940939",
        bundleID: "flux.inchmade.app",
        name: "Forward",
        artistName: "Forward Team",
        builds: { ios: { version: "1.3.18", updatedAt: 5 } },
        updatedAt: 6,
      },
    ]);

    const res = await request(app).get(
      "/api/search?term=fwd&country=US&entity=software&platform=ios",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 6503940939,
      name: "Forward",
      version: "1.3.19",
    });
    expect(res.body[0].metadataSource).toBeUndefined();
  });

  it("GET /api/search keeps the storefront result when the index knows the same app", async () => {
    replyWithJson(iTunesPayload);
    mockedSearchLocal.mockReturnValue([
      {
        appId: "1492142120",
        bundleID: "com.example.utility",
        name: "Example Utility",
        builds: {},
        updatedAt: 6,
      },
    ]);

    const res = await request(app).get("/api/search?term=utility&platform=ios");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1492142120);
    expect(res.body[0].metadataSource).toBeUndefined();
  });
});

describe("Lookup Route", () => {
  const app = createApp();

  it("GET /api/lookup forwards id and entity, then stamps the platform", async () => {
    replyWithJson(iTunesPayload);

    const res = await request(app).get(
      "/api/lookup?id=1492142120&country=US&platform=tvos&entity=tvSoftware",
    );

    expect(res.status).toBe(200);
    const requested = iTunesFetch.mock.calls[0][0] as string;
    const query = new URLSearchParams(requested.split("?")[1]);
    expect(query.get("id")).toBe("1492142120");
    expect(query.get("entity")).toBe("tvSoftware");
    expect(query.get("platform")).toBeNull();
    expect(res.body.platform).toBe("tvos");
  });

  it("GET /api/lookup returns null when Apple knows no such app", async () => {
    replyWithJson({ resultCount: 0, results: [] });

    const res = await request(app).get("/api/lookup?id=1&platform=ios");

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});