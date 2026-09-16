import { describe, it, expect } from "vitest";
import { appPathSegment } from "../src/services/downloadManager.js";
import type { Software } from "../src/types/index.js";

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
