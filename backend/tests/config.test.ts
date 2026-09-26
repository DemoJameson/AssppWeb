import { describe, it, expect } from "vitest";
import {
  config,
  parseStorefrontFallbackCountries,
  parseTrustProxy,
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
