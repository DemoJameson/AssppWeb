import { describe, it, expect } from "vitest";
import {
  userAgent,
  countryCodeMap,
  generateDeviceId,
  storeAPIHost,
  purchaseAPIHost,
  countryToStoreId,
  storeIdToCountry,
  authStoreFront,
  RETRYABLE_FAILURE_TYPE,
  volumeStoreEndpoint,
  redownloadEndpoint,
  downloadDispatchEndpoint,
} from "../../src/apple/config";

describe("apple/config", () => {
  describe("userAgent", () => {
    it("should be the Configurator user agent string", () => {
      expect(userAgent).toContain("Configurator/2.17");
      expect(userAgent).toContain("Macintosh");
      expect(userAgent).toContain("AppleWebKit");
    });
  });

  describe("countryCodeMap", () => {
    it("should contain US with correct store ID", () => {
      expect(countryCodeMap["US"]).toBe("143441");
    });

    it("should contain GB with correct store ID", () => {
      expect(countryCodeMap["GB"]).toBe("143444");
    });

    it("should contain JP with correct store ID", () => {
      expect(countryCodeMap["JP"]).toBe("143462");
    });

    it("should contain CN with correct store ID", () => {
      expect(countryCodeMap["CN"]).toBe("143465");
    });

    it("should have more than 100 country codes", () => {
      expect(Object.keys(countryCodeMap).length).toBeGreaterThan(100);
    });

    it("should match the original Swift Configuration.swift values", () => {
      // Spot-check several entries against the Swift source
      expect(countryCodeMap["FR"]).toBe("143442");
      expect(countryCodeMap["DE"]).toBe("143443");
      expect(countryCodeMap["AU"]).toBe("143460");
      expect(countryCodeMap["CA"]).toBe("143455");
      expect(countryCodeMap["BR"]).toBe("143503");
      expect(countryCodeMap["IN"]).toBe("143467");
      expect(countryCodeMap["KR"]).toBe("143466");
      expect(countryCodeMap["RU"]).toBe("143469");
    });
  });

  describe("generateDeviceId", () => {
    it("should generate a hex string", () => {
      const id = generateDeviceId();
      expect(id).toMatch(/^[0-9a-f]+$/);
    });

    it("should be 12 characters (6 bytes hex)", () => {
      const id = generateDeviceId();
      expect(id.length).toBe(12);
    });

    it("should generate different IDs each call", () => {
      const id1 = generateDeviceId();
      const id2 = generateDeviceId();
      expect(id1).not.toBe(id2);
    });

    it("should not contain colons, dashes, or spaces", () => {
      const id = generateDeviceId();
      expect(id).not.toContain(":");
      expect(id).not.toContain("-");
      expect(id).not.toContain(" ");
    });
  });

  describe("storeAPIHost", () => {
    it("should return pod-based host when pod is provided", () => {
      expect(storeAPIHost("25")).toBe("p25-buy.itunes.apple.com");
      expect(storeAPIHost("71")).toBe("p71-buy.itunes.apple.com");
    });

    it("should return default host when pod is undefined", () => {
      expect(storeAPIHost()).toBe("p25-buy.itunes.apple.com");
      expect(storeAPIHost(undefined)).toBe("p25-buy.itunes.apple.com");
    });
  });

  describe("purchaseAPIHost", () => {
    it("should return pod-based host when pod is provided", () => {
      expect(purchaseAPIHost("25")).toBe("p25-buy.itunes.apple.com");
      expect(purchaseAPIHost("71")).toBe("p71-buy.itunes.apple.com");
    });

    it("should return default host when pod is undefined", () => {
      expect(purchaseAPIHost()).toBe("buy.itunes.apple.com");
      expect(purchaseAPIHost(undefined)).toBe("buy.itunes.apple.com");
    });
  });

  describe("countryToStoreId", () => {
    it("should return store ID for valid country code", () => {
      expect(countryToStoreId("US")).toBe("143441");
    });

    it("should be case-insensitive", () => {
      expect(countryToStoreId("us")).toBe("143441");
      expect(countryToStoreId("Gb")).toBe("143444");
    });

    it("should return undefined for unknown country", () => {
      expect(countryToStoreId("XX")).toBeUndefined();
    });
  });

  describe("storeIdToCountry", () => {
    it("should return country code for valid store ID", () => {
      expect(storeIdToCountry("143441")).toBe("US");
    });

    it("should return undefined for unknown store ID", () => {
      expect(storeIdToCountry("999999")).toBeUndefined();
    });
  });

  describe("authStoreFront", () => {
    const entries: [string, string][] = [
      ["13800138000", "143465"],
      ["+8613800138000", "143465"],
      ["138-0013-8000", "143465"],
      ["008613800138000", "143465"],
      ["8613800138000", "143465"],
      ["9876543210", "143467"],
      ["09876543210", "143467"],
      ["919876543210", "143467"],
      ["test@example.com", ""],
      ["13800138000@example.com", ""],
      ["", ""],
      ["1380013800", ""],
    ];

    it.each(entries)("resolves %s to %s", (identifier, expected) => {
      expect(authStoreFront(identifier)).toBe(expected);
    });
  });

  describe("store download endpoints", () => {
    it("volumeStore targets MZFinance with the externalVersionId key", () => {
      const ep = volumeStoreEndpoint("42", "aabbccddeeff");
      expect(ep.host).toBe("p42-buy.itunes.apple.com");
      expect(ep.path).toBe(
        "/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
      );
      expect(ep.externalVersionIdKey).toBe("externalVersionId");
    });

    it("redownload targets downloaddispatch with the appExtVrsId key", () => {
      const ep = redownloadEndpoint("aabbccddeeff");
      expect(ep.host).toBe("downloaddispatch.itunes.apple.com");
      expect(ep.path).toBe("/r/redownload?guid=aabbccddeeff");
      expect(ep.externalVersionIdKey).toBe("appExtVrsId");
    });

    it("exposes the retryable failure type used for fallback", () => {
      expect(RETRYABLE_FAILURE_TYPE).toBe("5002");
    });
  });

  describe("downloadDispatchEndpoint", () => {
    it("accepts the exact host and path pair the bag advertises", () => {
      const ep = downloadDispatchEndpoint(
        "https://downloaddispatch.itunes.apple.com/r/redownload",
        "/r/redownload",
        "aabbccddeeff",
      );
      expect(ep).toEqual({
        host: "downloaddispatch.itunes.apple.com",
        path: "/r/redownload?guid=aabbccddeeff",
        externalVersionIdKey: "appExtVrsId",
      });
    });

    it("accepts the updateProduct path for the same host", () => {
      const ep = downloadDispatchEndpoint(
        "https://downloaddispatch.itunes.apple.com/up/updateProduct",
        "/up/updateProduct",
        "aabbccddeeff",
      );
      expect(ep?.path).toBe("/up/updateProduct?guid=aabbccddeeff");
    });

    it("rejects a host that is not the dispatch host", () => {
      expect(
        downloadDispatchEndpoint(
          "https://downloaddispatch.evil.example/r/redownload",
          "/r/redownload",
          "aabbccddeeff",
        ),
      ).toBeNull();
    });

    it("rejects a path the caller did not ask for", () => {
      expect(
        downloadDispatchEndpoint(
          "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download",
          "/r/redownload",
          "aabbccddeeff",
        ),
      ).toBeNull();
    });

    it("rejects anything appended to the advertised URL", () => {
      for (const url of [
        "https://downloaddispatch.itunes.apple.com/r/redownload?guid=x",
        "https://downloaddispatch.itunes.apple.com/r/redownload#frag",
        "https://user@downloaddispatch.itunes.apple.com/r/redownload",
        "http://downloaddispatch.itunes.apple.com/r/redownload",
        "not a url",
      ]) {
        expect(
          downloadDispatchEndpoint(url, "/r/redownload", "aabbccddeeff"),
        ).toBeNull();
      }
    });
  });
});
