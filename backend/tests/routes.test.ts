import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";
import { createServer, Server } from "http";
import settingsRoutes from "../src/routes/settings.js";
import installRoutes from "../src/routes/install.js";
import { getBaseUrl, matchConfiguredBaseUrl } from "../src/routes/install.js";
import { config } from "../src/config.js";
import downloadRoutes from "../src/routes/downloads.js";
import packageRoutes from "../src/routes/packages.js";
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
  app.use("/api", packageRoutes);
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
    // Apple serves a macOS package encrypted, so a request must say what to decrypt it with;
    // without it a package nothing can open would be fetched in full and then thrown away.
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

  it("POST /api/downloads should refuse a sinfs value that is not a list of sinfs", async () => {
    // `sinfs` is indexed and base64-decoded inside the injector, well past the
    // point where the caller could be told what was wrong.
    const base = {
      software: {
        id: 1492142120,
        bundleID: "com.example.utility",
        name: "Example",
        version: "1.0",
      },
      accountHash: "abcdef1234567890",
      downloadURL: "https://example.apple.com/app.ipa",
    };

    for (const sinfs of ["AAAA", [{}], [{ id: 0 }], [null]]) {
      const res = await request(app)
        .post("/api/downloads")
        .send({ ...base, sinfs });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sinfs");
    }
  });

  it("POST /api/downloads should refuse a mistyped software field or metadata", async () => {
    const base = {
      software: {
        id: 1492142120,
        bundleID: "com.example.utility",
        name: "Example",
        version: "1.0",
      },
      accountHash: "abcdef1234567890",
      downloadURL: "https://example.apple.com/app.ipa",
      sinfs: [],
    };

    const badMetadata = await request(app)
      .post("/api/downloads")
      .send({ ...base, iTunesMetadata: 5 });
    expect(badMetadata.status).toBe(400);
    expect(badMetadata.body.error).toContain("iTunesMetadata");

    // A number where a name belongs would only surface when the file is named.
    const badName = await request(app)
      .post("/api/downloads")
      .send({ ...base, software: { ...base.software, name: 7 } });
    expect(badName.status).toBe(400);
    expect(badName.body.error).toContain("software.name");
  });
});

describe("Packages Route", () => {
  const app = createApp();

  it("DELETE /api/packages/:id should return 400 without accountHash", async () => {
    const res = await request(app).delete("/api/packages/nonexistent-id");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("DELETE /api/packages/:id should return 404 for a task that is not there", async () => {
    // The handler hands deletion to the download manager, keeping a `completed` task from
    // outliving its package — `downloadManager.test.ts` covers that removal.
    const res = await request(app).delete(
      "/api/packages/nonexistent-id?accountHash=abcdef1234567890",
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

  it("uses the configured origins instead once they are set", () => {
    // The list is read per request, so a test can stand one up and restore the real value
    // without touching the environment. Restored in a `finally` because the rest of this
    // describe expects the unconfigured path.
    const original = config.publicBaseUrls;
    config.publicBaseUrls = ["https://asspp.example.com"];
    try {
      expect(getBaseUrl(fakeReq({ host: "asspp.example.com" }))).toBe(
        "https://asspp.example.com",
      );
      // Including the port a CDN may have put in Host.
      expect(getBaseUrl(fakeReq({ host: "asspp.example.com:12345" }))).toBe(
        "https://asspp.example.com",
      );
      // And the scheme now comes from the configuration, whatever the proxy
      // declares — which is the point of setting it.
      expect(
        getBaseUrl(
          fakeReq({ host: "asspp.example.com", "x-forwarded-proto": "http" }),
        ),
      ).toBe("https://asspp.example.com");
    } finally {
      config.publicBaseUrls = original;
    }
  });

  it("keeps an IPv6 literal intact on the way into the match", () => {
    // The Host sanitizer used to strip the brackets, collapsing the literal
    // into a colon run that could never equal a configured origin.
    const original = config.publicBaseUrls;
    config.publicBaseUrls = ["https://[2001:db8::1]:8443"];
    try {
      expect(getBaseUrl(fakeReq({ host: "[2001:db8::1]:8443" }))).toBe(
        "https://[2001:db8::1]:8443",
      );
    } finally {
      config.publicBaseUrls = original;
    }
  });
});

describe("matchConfiguredBaseUrl", () => {
  const both = [
    "https://asspp.demojameson.cn",
    "https://asspp.demojameson.de5.net",
  ];

  it("links each hostname to itself", () => {
    expect(matchConfiguredBaseUrl(both, "asspp.demojameson.cn")).toBe(
      "https://asspp.demojameson.cn",
    );
    expect(matchConfiguredBaseUrl(both, "asspp.demojameson.de5.net")).toBe(
      "https://asspp.demojameson.de5.net",
    );
  });

  it("ignores the port a proxy put in Host", () => {
    // A CDN that terminates on 443 but dials the origin on another port
    // forwards that port in Host; the configured origin stays authoritative.
    expect(matchConfiguredBaseUrl(both, "asspp.demojameson.cn:12345")).toBe(
      "https://asspp.demojameson.cn",
    );
    expect(matchConfiguredBaseUrl(both, "asspp.demojameson.de5.net:8080")).toBe(
      "https://asspp.demojameson.de5.net",
    );
  });

  it("matches hostnames case-insensitively", () => {
    expect(matchConfiguredBaseUrl(both, "Asspp.DemoJameson.CN")).toBe(
      "https://asspp.demojameson.cn",
    );
  });

  it("falls back to the first entry for an unlisted host", () => {
    expect(matchConfiguredBaseUrl(both, "192.168.50.3:28080")).toBe(
      "https://asspp.demojameson.cn",
    );
    expect(matchConfiguredBaseUrl(both, "localhost")).toBe(
      "https://asspp.demojameson.cn",
    );
  });

  it("keeps a configured non-standard port in the emitted origin", () => {
    expect(
      matchConfiguredBaseUrl(["https://asspp.example.com:8443"], "asspp.example.com"),
    ).toBe("https://asspp.example.com:8443");
  });

  it("does not let an unlisted hostname in a subdomain match", () => {
    expect(matchConfiguredBaseUrl(both, "evil-asspp.demojameson.cn")).toBe(
      "https://asspp.demojameson.cn",
    );
  });

  it("uses the request's port to choose between entries for one hostname", () => {
    const ports = ["https://x.example.com", "https://x.example.com:8443"];
    expect(matchConfiguredBaseUrl(ports, "x.example.com:8443")).toBe(
      "https://x.example.com:8443",
    );
    expect(matchConfiguredBaseUrl(ports, "x.example.com")).toBe(
      "https://x.example.com",
    );
    // Neither port is listed: the first entry still wins rather than inventing
    // a port the deployment never named.
    expect(matchConfiguredBaseUrl(ports, "x.example.com:9999")).toBe(
      "https://x.example.com",
    );
  });

  it("matches an IPv6 literal, brackets and all", () => {
    const candidates = ["https://[2001:db8::1]:8443", "https://x.example.com"];
    expect(matchConfiguredBaseUrl(candidates, "[2001:db8::1]:8443")).toBe(
      "https://[2001:db8::1]:8443",
    );
    // A literal with no port still matches its bracketed form.
    expect(matchConfiguredBaseUrl(candidates, "[2001:db8::1]")).toBe(
      "https://[2001:db8::1]:8443",
    );
    // A colon run the request wrote without brackets is not a port either.
    expect(matchConfiguredBaseUrl(both, "2001:db8::1")).toBe(
      "https://asspp.demojameson.cn",
    );
  });

  it("offers nothing when no candidate is configured", () => {
    // `getBaseUrl` guards the empty list; the function stays total anyway
    // rather than handing back an undefined typed as a string.
    expect(matchConfiguredBaseUrl([], "x.example.com")).toBe("");
  });
});
