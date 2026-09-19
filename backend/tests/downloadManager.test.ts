import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  appPathSegment,
  applyPackageMetadata,
  assertPackageMatchesPlatform,
  iconPathFor,
  softwareForPersistence,
} from "../src/services/downloadManager.js";
import type { DownloadTask, Software } from "../src/types/index.js";

function software(overrides: Partial<Software>): Software {
  return {
    id: 1492142120,
    bundleID: "com.example.utility",
    name: "Example Utility",
    version: "1.2.3",
    artistName: "",
    sellerName: "",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "",
    releaseDate: "",
    primaryGenreName: "",
    ...overrides,
  };
}

describe("assertPackageMatchesPlatform", () => {
  const pkgUrl = "https://iosapps.example.com/app.pkg";
  const ipaUrl = "https://iosapps.example.com/app.ipa";

  it("refuses a macOS package for a task that is not a macOS one", () => {
    // The version pin that selects the build can have been guessed, so a tvOS or
    // visionOS task really can be offered a Mac package — and it would only fail
    // after the whole thing had been downloaded.
    expect(() => assertPackageMatchesPlatform(pkgUrl, "tvos")).toThrow(
      /macOS package/,
    );
    expect(() => assertPackageMatchesPlatform(pkgUrl, "visionos")).toThrow();
    expect(() => assertPackageMatchesPlatform(pkgUrl, "ios")).toThrow();
    expect(() => assertPackageMatchesPlatform(pkgUrl, undefined)).toThrow();
  });

  it("lets a macOS task keep its package", () => {
    expect(() => assertPackageMatchesPlatform(pkgUrl, "macos")).not.toThrow();
  });

  it("does not mind an IPA, or a URL with no extension", () => {
    for (const platform of ["ios", "tvos", "visionos", "macos"] as const) {
      expect(() => assertPackageMatchesPlatform(ipaUrl, platform)).not.toThrow();
      expect(() =>
        assertPackageMatchesPlatform(
          "https://iosapps.example.com/download",
          platform,
        ),
      ).not.toThrow();
    }
  });

  it("looks at the path, not the query", () => {
    expect(() =>
      assertPackageMatchesPlatform(`${ipaUrl}?token=.pkg`, "tvos"),
    ).not.toThrow();
    expect(() => assertPackageMatchesPlatform(`${pkgUrl}?x=1`, "tvos")).toThrow();
  });
});

describe("appPathSegment", () => {
  it("uses the bundle identifier when the storefront reported one", () => {
    expect(appPathSegment(software({}))).toBe("com.example.utility");
  });

  it("falls back to the numeric app id when there is no bundle identifier", () => {
    // ipatool keys a download off the app id and omits fields it does not know,
    // so an id-only download must still get a usable, collision-free segment.
    expect(appPathSegment(software({ bundleID: "" }))).toBe("1492142120");
  });

  it("sanitizes a bundle identifier that is not path-safe", () => {
    expect(appPathSegment(software({ bundleID: "com.example/a b" }))).toBe(
      "com.example_a_b",
    );
  });

  it("prefers the app id over a traversing bundle identifier", () => {
    // An empty value is the only case that falls back; a traversal attempt is
    // still rejected outright rather than silently accepted.
    expect(appPathSegment(software({ bundleID: "" }))).toBe("1492142120");
    expect(() => appPathSegment(software({ bundleID: ".." }))).toThrow();
  });
});

describe("iconPathFor", () => {
  const TEMP_DIR = path.join(os.tmpdir(), "download-manager-icon-test");

  beforeAll(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  function task(filePath?: string): DownloadTask {
    return {
      id: "task-id",
      software: software({}),
      accountHash: "abcdef1234567890",
      downloadURL: "",
      sinfs: [],
      status: "completed",
      progress: 100,
      speed: "0 B/s",
      filePath,
      createdAt: "2026-09-16T00:00:00.000Z",
    };
  }

  it("finds the icon the compile parked beside the IPA", () => {
    // The icon is located by name alone, so a task needs no extra field for it.
    const dir = fs.mkdtempSync(path.join(TEMP_DIR, "task-"));
    fs.writeFileSync(path.join(dir, "task.ipa"), "ipa");
    fs.writeFileSync(path.join(dir, "icon.png"), "icon");

    expect(iconPathFor(task(path.join(dir, "task.ipa")))).toBe(
      path.join(dir, "icon.png"),
    );
  });

  it("finds a JPEG icon too, which is the only other shape a bundle carries", () => {
    const dir = fs.mkdtempSync(path.join(TEMP_DIR, "jpg-"));
    fs.writeFileSync(path.join(dir, "task.ipa"), "ipa");
    fs.writeFileSync(path.join(dir, "icon.jpg"), "icon");

    expect(iconPathFor(task(path.join(dir, "task.ipa")))).toBe(
      path.join(dir, "icon.jpg"),
    );
  });

  it("returns null when the package carried no icon", () => {
    const dir = fs.mkdtempSync(path.join(TEMP_DIR, "none-"));
    fs.writeFileSync(path.join(dir, "task.ipa"), "ipa");

    expect(iconPathFor(task(path.join(dir, "task.ipa")))).toBeNull();
  });

  it("returns null before the task has a file at all", () => {
    expect(iconPathFor(task())).toBeNull();
  });
});

describe("applyPackageMetadata", () => {
  const fromPackage = {
    name: "Package Name",
    artistName: "Package Developer",
    bundleID: "com.package.app",
    version: "9.9.9",
    minimumOsVersion: "17.0",
    primaryGenreName: "Utilities",
    releaseDate: "2026-01-02T03:04:05Z",
    artworkURL: "https://cdn.apple.com/icon.jpg",
  };

  it("fills in everything a download by bare app id could not know", () => {
    const target = software({
      bundleID: "",
      name: "App 1492142120",
      version: "",
      artistName: "",
      minimumOsVersion: "",
      primaryGenreName: "",
      releaseDate: "",
    });

    applyPackageMetadata(target, fromPackage);

    expect(target.name).toBe("Package Name");
    expect(target.bundleID).toBe("com.package.app");
    expect(target.version).toBe("9.9.9");
    expect(target.artistName).toBe("Package Developer");
    expect(target.minimumOsVersion).toBe("17.0");
    expect(target.primaryGenreName).toBe("Utilities");
    expect(target.releaseDate).toBe("2026-01-02T03:04:05Z");
  });

  it("keeps the values the storefront already reported", () => {
    const target = software({
      artistName: "Storefront Developer",
      minimumOsVersion: "16.0",
      primaryGenreName: "Productivity",
      releaseDate: "2025-12-31T00:00:00Z",
    });

    applyPackageMetadata(target, fromPackage);

    // The storefront's own values survive; only the missing ones are filled.
    expect(target.name).toBe("Example Utility");
    expect(target.artistName).toBe("Storefront Developer");
    expect(target.minimumOsVersion).toBe("16.0");
    expect(target.primaryGenreName).toBe("Productivity");
    expect(target.releaseDate).toBe("2025-12-31T00:00:00Z");
    expect(target.bundleID).toBe("com.example.utility");
    expect(target.version).toBe("1.2.3");
  });

  it("keeps the id label when the package offers no name", () => {
    const target = software({ name: "App 1492142120" });

    applyPackageMetadata(target, {});

    expect(target.name).toBe("App 1492142120");
  });

  it("does not blank a field when neither side has a value", () => {
    const target = software({ artistName: "", minimumOsVersion: "" });

    applyPackageMetadata(target, {});

    expect(target.artistName).toBe("");
    expect(target.minimumOsVersion).toBe("");
  });

  it("fills in the icon URL Apple handed out with the download", () => {
    // The only icon a package with no loose image can offer — a tvOS build
    // keeps its icon inside Assets.car, which is not worth parsing.
    const target = software();

    expect(applyPackageMetadata(target, fromPackage)).toBe(true);
    expect(target.artworkUrl).toBe("https://cdn.apple.com/icon.jpg");
  });

  it("keeps the icon the storefront already reported", () => {
    const target = software({ artworkUrl: "https://cdn.apple.com/store.jpg" });

    expect(applyPackageMetadata(target, fromPackage)).toBe(true);
    expect(target.artworkUrl).toBe("https://cdn.apple.com/store.jpg");
  });

  it("reports whether it changed anything", () => {
    // The startup repair relies on this to know what to persist.
    expect(applyPackageMetadata(software({}), {})).toBe(false);
    expect(applyPackageMetadata(software({}), fromPackage)).toBe(true);
  });
});

describe("softwareForPersistence", () => {
  it("strips the search-origin marker without mutating the input", () => {
    const withSource = software({ metadataSource: "local" });

    const stripped = softwareForPersistence(withSource);

    expect(stripped.metadataSource).toBeUndefined();
    expect(stripped.id).toBe(1492142120);
    // The in-memory task keeps its marker; only the on-disk copy drops it.
    expect(withSource.metadataSource).toBe("local");
  });

  it("leaves software without a marker unchanged in shape", () => {
    expect(softwareForPersistence(software({}))).toEqual(software({}));
  });
});
