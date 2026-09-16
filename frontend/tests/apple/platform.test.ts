import { describe, expect, it } from "vitest";
import {
  PLATFORMS,

  PLATFORM_LABELS,
  lookupEntityFor,
  metadataPlatformFor,
  parsePlatform,
  searchEntityFor,
} from "../../src/apple/platform";

describe("searchEntityFor", () => {
  it("mirrors ipatool's Platform.searchEntity()", () => {
    expect(searchEntityFor("ios")).toBe("software");
    expect(searchEntityFor("ipad")).toBe("iPadSoftware");
    // The storefront lists tvOS builds alongside the iOS app.
    expect(searchEntityFor("tvos")).toBe("software,tvSoftware");
    expect(searchEntityFor("visionos")).toBe("xrosSoftware");
    expect(searchEntityFor("macos")).toBe("macSoftware");
  });
});

describe("lookupEntityFor", () => {
  it("mirrors ipatool's Platform.lookupEntity()", () => {
    expect(lookupEntityFor("ios")).toBe("software");
    expect(lookupEntityFor("ipad")).toBe("iPadSoftware");
    expect(lookupEntityFor("tvos")).toBe("tvSoftware");
    expect(lookupEntityFor("visionos")).toBe("xrosSoftware");
    expect(lookupEntityFor("macos")).toBe("macSoftware");
  });
});

describe("metadataPlatformFor", () => {
  it("asks Apple's enterprise catalogue for iPhone and iPad", () => {
    // ipatool's `metadataPlatform()`: the two share a catalogue.
    expect(metadataPlatformFor("ios")).toBe("enterprisestore");
    expect(metadataPlatformFor("ipad")).toBe("enterprisestore");
  });

  it("asks the Apple TV catalogue for tvOS", () => {
    expect(metadataPlatformFor("tvos")).toBe("atv9");
  });

  it("asks the reality device catalogue for visionOS", () => {
    expect(metadataPlatformFor("visionos")).toBe("realityDevice");
  });

  it("has no catalogue for macOS — the caller must skip the pin", () => {
    expect(metadataPlatformFor("macos")).toBeUndefined();
  });

  it("falls back to the default catalogue when no platform was chosen", () => {
    expect(metadataPlatformFor(undefined)).toBe("enterprisestore");
  });
});

describe("parsePlatform", () => {
  it("accepts ipatool's aliases case-insensitively", () => {
    expect(parsePlatform("iOS")).toBe("ios");
    expect(parsePlatform("iphone")).toBe("ios");
    expect(parsePlatform("iPad")).toBe("ipad");
    expect(parsePlatform("tvOS")).toBe("tvos");
    expect(parsePlatform("AppleTV")).toBe("tvos");
    expect(parsePlatform("VisionOS")).toBe("visionos");
    expect(parsePlatform("macOS")).toBe("macos");
  });

  it("rejects anything unknown", () => {
    expect(parsePlatform("windows")).toBeUndefined();
    expect(parsePlatform("")).toBeUndefined();
    expect(parsePlatform(undefined)).toBeUndefined();
    expect(parsePlatform(42)).toBeUndefined();
  });
});

describe("PLATFORMS", () => {
  it("covers every platform the labels and mappers know", () => {
    for (const platform of PLATFORMS) {
      expect(PLATFORM_LABELS[platform]).toBeTruthy();
      expect(searchEntityFor(platform)).toBeTruthy();
      expect(lookupEntityFor(platform)).toBeTruthy();
    }
  });
});
