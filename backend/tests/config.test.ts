import { describe, it, expect } from "vitest";
import {
  config,
  parsePublicBaseUrls,
  parseStorefrontFallbackCountries,
  parseTrustProxy,
  publicBaseUrlWarning,
} from "../src/config.js";

describe("config", () => {
  it("should have default port 8080", () => {
    expect(config.port).toBe(8080);
  });

  it("should have default data directory", () => {
    expect(config.dataDir).toBe("./data");
  });

  it("should default the storefront fallback to the CN storefront", () => {
    expect(config.storefrontFallbackCountries).toEqual(["cn"]);
  });

  it("should leave trust proxy off by default", () => {
    // Nothing trustworthy sits in front of a default deployment, and a client
    // can forge the header the setting would make Express believe.
    expect(config.trustProxy).toBe(false);
  });
});

describe("parseTrustProxy", () => {
  it("keeps the setting off when unset, empty or explicitly false", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy(" false ")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  it("accepts true, a hop count, and Express's own address lists", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("10.0.0.0/8, 192.168.0.0/16")).toBe(
      "10.0.0.0/8, 192.168.0.0/16",
    );
  });
});

describe("parsePublicBaseUrls", () => {
  it("keeps auto-detection when the variable is unset or empty", () => {
    expect(parsePublicBaseUrls(undefined)).toEqual([]);
    expect(parsePublicBaseUrls("")).toEqual([]);
    expect(parsePublicBaseUrls("  ,  ")).toEqual([]);
  });

  it("accepts a single origin, trailing slashes trimmed", () => {
    expect(parsePublicBaseUrls("https://asspp.example.com/")).toEqual([
      "https://asspp.example.com",
    ]);
  });

  it("keeps each hostname of a comma-separated list, in order", () => {
    expect(
      parsePublicBaseUrls(
        "https://asspp.demojameson.cn , https://asspp.demojameson.de5.net",
      ),
    ).toEqual([
      "https://asspp.demojameson.cn",
      "https://asspp.demojameson.de5.net",
    ]);
  });

  it("keeps an explicit port and a subpath", () => {
    expect(
      parsePublicBaseUrls("https://example.com:8443/asspp/"),
    ).toEqual(["https://example.com:8443/asspp"]);
  });

  it("canonicalises case and a default port away", () => {
    // A configured `https://X.example.com:443/app/` and a request's bare
    // `x.example.com` have to reduce to the same string to be comparable.
    expect(parsePublicBaseUrls("https://X.Example.com:443/app/")).toEqual([
      "https://x.example.com/app",
    ]);
    expect(parsePublicBaseUrls("http://A.example.com:80")).toEqual([
      "http://a.example.com",
    ]);
  });

  it("dedupes repeated origins", () => {
    expect(
      parsePublicBaseUrls("https://a.example.com,https://a.example.com/"),
    ).toEqual(["https://a.example.com"]);
  });

  it("drops anything that is not an absolute http(s) URL", () => {
    // A typo must fall back to host auto-detection rather than produce a link
    // iOS cannot follow.
    expect(
      parsePublicBaseUrls("asspp.example.com,ftp://example.com,,https://ok.example.com"),
    ).toEqual(["https://ok.example.com"]);
  });
});

describe("publicBaseUrlWarning", () => {
  it("says nothing when the variable is unset or usable", () => {
    expect(publicBaseUrlWarning(undefined)).toBeNull();
    expect(publicBaseUrlWarning("")).toBeNull();
    expect(publicBaseUrlWarning("https://asspp.example.com")).toBeNull();
    // One usable entry is enough, however many duds sit beside it.
    expect(
      publicBaseUrlWarning("https://ok.example.com, not-a-url, ftp://nope"),
    ).toBeNull();
  });

  it("warns when the value contributes no origin at all", () => {
    // The silent failure: install links quietly come from the request Host
    // instead, which looks exactly like the configuration having worked.
    const warning = publicBaseUrlWarning("asspp.example.com");
    expect(warning).toContain("asspp.example.com");
    expect(warning).toContain("no absolute http(s) URL");
    expect(warning).toContain("https://asspp.example.com");
  });
});

describe("parseStorefrontFallbackCountries", () => {
  it("keeps the cn default when the variable is unset", () => {
    expect(parseStorefrontFallbackCountries(undefined)).toEqual(["cn"]);
  });

  it("lowercases and dedupes a configured list", () => {
    expect(parseStorefrontFallbackCountries("CN, jp ,cn")).toEqual([
      "cn",
      "jp",
    ]);
  });

  it("drops entries that are not two-letter country codes", () => {
    expect(parseStorefrontFallbackCountries("cn,,USA,1x, us ")).toEqual([
      "cn",
      "us",
    ]);
  });

  it("disables the fallback when set empty", () => {
    expect(parseStorefrontFallbackCountries("")).toEqual([]);
  });
});
