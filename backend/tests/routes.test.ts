import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";
import { createServer, Server } from "http";
import settingsRoutes from "../src/routes/settings.js";
import installRoutes from "../src/routes/install.js";
import { getBaseUrl } from "../src/routes/install.js";
import downloadRoutes from "../src/routes/downloads.js";
import {
  packageDownloadExtension,
  packageDownloadName,
} from "../src/routes/packages.js";
import type { Platform } from "../src/types/index.js";

function createApp() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api", settingsRoutes);
  app.use("/api", installRoutes);
  app.use("/api", downloadRoutes);
  return app;
}

describe("Settings Route", () => {
  const app = createApp();

  it("GET /api/settings should return server info", async () => {
    const res = await request(app).get("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("dataDir");
    expect(res.body).toHaveProperty("uptime");
    expect(res.body).toHaveProperty("downloadThreads");
    expect(res.body.storefrontFallbackCountries).toEqual(["cn"]);
  });
});

describe("package download name", () => {
  it("names a macOS download a .pkg", () => {
    // A Mac package is a xar container; saving it as `.ipa` hands the user a
    // file macOS refuses to open, whatever its bytes are.
    expect(packageDownloadName("SenPlayer", "6.2.1", "macos")).toBe(
      "SenPlayer_6.2.1_macOS.pkg",
    );
    expect(packageDownloadExtension("macos")).toBe(".pkg");
  });

  it("keeps the .ipa for the packages that are IPAs", () => {
    const names: Record<string, string> = {
      ios: "Example_1.0_iOS.ipa",
      ipad: "Example_1.0_iPadOS.ipa",
      tvos: "Example_1.0_tvOS.ipa",
      visionos: "Example_1.0_visionOS.ipa",
    };
    for (const [platform, expected] of Object.entries(names)) {
      expect(packageDownloadName("Example", "1.0", platform as Platform)).toBe(
        expected,
      );
      expect(packageDownloadExtension(platform as Platform)).toBe(".ipa");
    }
    // A platform the request did not carry is an iOS download (the historical
    // default), which is an IPA too.
    expect(packageDownloadExtension(undefined)).toBe(".ipa");
  });

  it("keeps the name safe for the filesystem", () => {
    expect(packageDownloadName('a/b:c*d?"e<', "1.0", "macos")).toBe(
      "a-b-c-d--e-_1.0_macOS.pkg",
    );
  });
});

describe("Downloads Route", () => {
  const app = createApp();

  it("GET /api/downloads should return empty array initially", async () => {
    const res = await request(app).get("/api/downloads");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/downloads should reject missing fields", async () => {
    const res = await request(app)
      .post("/api/downloads")
      .send({ software: { id: 1 } }); // Missing accountHash, downloadURL, sinfs

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/downloads should reject a request without an app id", async () => {
    // The app id is what Apple is asked for and what names the package
    // directory when the bundle id is unknown, so it cannot be defaulted.
    const res = await request(app)
      .post("/api/downloads")
      .send({
        software: { bundleID: "com.example.utility", name: "Example" },
        accountHash: "abcdef1234567890",
        downloadURL: "https://example.apple.com/app.ipa",
        sinfs: [{ id: 0, sinf: "AAAA" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("app id");
  });

  it("POST /api/downloads should reject a macOS download it could not decrypt", async () => {
    // Apple serves a macOS package encrypted, so a request has to say what to
    // decrypt it with. Without that a package nothing can open would be
    // fetched in full and then thrown away, so it is refused up front.
    const macRequest = (extra: Record<string, unknown>) => ({
      software: {
        id: 6443975850,
        bundleID: "com.example.player",
        name: "Example Player",
        version: "6.2.1",
        platform: "macos",
      },
      accountHash: "abcdef1234567890",
      downloadURL: "https://example.apple.com/app.pkg",
      sinfs: [],
      ...extra,
    });

    const withoutDPInfo = await request(app)
      .post("/api/downloads")
      .send(macRequest({}));
    expect(withoutDPInfo.status).toBe(400);
    expect(withoutDPInfo.body.error).toContain("dpInfo");

    const withoutHardwareId = await request(app)
      .post("/api/downloads")
      .send(macRequest({ dpInfo: "AA==", hardwareId: "not-hex" }));
    expect(withoutHardwareId.status).toBe(400);
    expect(withoutHardwareId.body.error).toContain("hardware id");
  });

  it("GET /api/downloads/:id should return 400 without accountHash", async () => {
    const res = await request(app).get("/api/downloads/nonexistent-id");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("GET /api/downloads/:id should return 404 with valid accountHash", async () => {
    const res = await request(app).get(
      "/api/downloads/nonexistent-id?accountHash=abcdef1234567890",
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/downloads/:id/icon should return 400 without accountHash", async () => {
    const res = await request(app).get("/api/downloads/nonexistent-id/icon");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("GET /api/downloads/:id/icon should return 404 with valid accountHash", async () => {
    // No icon is a normal outcome, and a 404 is what lets the client fall back
    // to its own placeholder.
    const res = await request(app).get(
      "/api/downloads/nonexistent-id/icon?accountHash=abcdef1234567890",
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/downloads/:id/pause should return 400 without accountHash", async () => {
    const res = await request(app).post("/api/downloads/nonexistent-id/pause");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("POST /api/downloads/:id/resume should return 400 without accountHash", async () => {
    const res = await request(app).post("/api/downloads/nonexistent-id/resume");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("DELETE /api/downloads/:id should return 400 without accountHash", async () => {
    const res = await request(app).delete("/api/downloads/nonexistent-id");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("DELETE /api/downloads/:id should return 404 with valid accountHash", async () => {
    const res = await request(app).delete(
      "/api/downloads/nonexistent-id?accountHash=abcdef1234567890",
    );
    expect(res.status).toBe(404);
  });
});

describe("Install Route", () => {
  const app = createApp();

  it("GET /api/install/:id/manifest.plist should return 404 for non-existent", async () => {
    const res = await request(app).get(
      "/api/install/nonexistent-id/manifest.plist",
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/install/:id/payload.ipa should return 404 for non-existent", async () => {
    const res = await request(app).get(
      "/api/install/nonexistent-id/payload.ipa",
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/install/:id/icon-small.png should return a PNG", async () => {
    const res = await request(app).get("/api/install/any-id/icon-small.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    // Check PNG magic bytes
    expect(res.body[0]).toBe(137);
    expect(res.body[1]).toBe(80); // P
    expect(res.body[2]).toBe(78); // N
    expect(res.body[3]).toBe(71); // G
  });

  it("GET /api/install/:id/icon-large.png should return a PNG", async () => {
    const res = await request(app).get("/api/install/any-id/icon-large.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });
});

describe("getBaseUrl", () => {
  function fakeReq(headers: Record<string, string>, secure = false) {
    return { headers, secure } as unknown as Request;
  }

  it("uses Host header with port when present", () => {
    const url = getBaseUrl(
      fakeReq({ host: "example.com:8443", "x-forwarded-proto": "https" }),
    );
    expect(url).toBe("https://example.com:8443");
  });

  it("uses X-Forwarded-Port when Host lacks port", () => {
    const url = getBaseUrl(
      fakeReq({
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "8443",
      }),
    );
    expect(url).toBe("https://example.com:8443");
  });

  it("omits port when X-Forwarded-Port is default 443 for HTTPS", () => {
    const url = getBaseUrl(
      fakeReq({
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "443",
      }),
    );
    expect(url).toBe("https://example.com");
  });

  it("omits port when X-Forwarded-Port is default 80 for HTTP", () => {
    const url = getBaseUrl(
      fakeReq({
        host: "example.com",
        "x-forwarded-port": "80",
      }),
    );
    expect(url).toBe("http://example.com");
  });

  it("does not override port already in Host header", () => {
    const url = getBaseUrl(
      fakeReq({
        host: "example.com:9000",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "8443",
      }),
    );
    expect(url).toBe("https://example.com:9000");
  });

  it("falls back to http when no forwarded proto and not secure", () => {
    const url = getBaseUrl(fakeReq({ host: "example.com" }));
    expect(url).toBe("http://example.com");
  });

  it("uses https when req.secure is true", () => {
    const url = getBaseUrl(fakeReq({ host: "example.com" }, true));
    expect(url).toBe("https://example.com");
  });

  it("sanitizes invalid characters in Host header", () => {
    const url = getBaseUrl(fakeReq({ host: "example.com/<script>" }));
    expect(url).toBe("http://example.comscript");
  });

  it("ignores non-numeric X-Forwarded-Port", () => {
    const url = getBaseUrl(
      fakeReq({
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "abc",
      }),
    );
    expect(url).toBe("https://example.com");
  });
});
