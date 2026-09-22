import { describe, it, expect } from "vitest";
import {
  config,
  parseStorefrontFallbackCountries,
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
