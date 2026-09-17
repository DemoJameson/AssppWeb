import { describe, it, expect } from "vitest";
import { looksLikeBundleId } from "../../src/utils/bundleId";

describe("looksLikeBundleId", () => {
  it("accepts reverse-DNS shapes", () => {
    expect(looksLikeBundleId("com.example.app")).toBe(true);
    expect(looksLikeBundleId("flux.inchmade.app")).toBe(true);
    expect(looksLikeBundleId("me.app")).toBe(true);
    expect(looksLikeBundleId("com.example-app2.tool")).toBe(true);
    expect(looksLikeBundleId("  com.example.app  ")).toBe(true);
  });

  it("rejects plain text and malformed ids", () => {
    expect(looksLikeBundleId("微信")).toBe(false);
    expect(looksLikeBundleId("whatsapp")).toBe(false);
    expect(looksLikeBundleId("example app")).toBe(false);
    expect(looksLikeBundleId(".com.example")).toBe(false);
    expect(looksLikeBundleId("com.example.")).toBe(false);
    expect(looksLikeBundleId("com..example")).toBe(false);
    expect(looksLikeBundleId("")).toBe(false);
    expect(looksLikeBundleId("   ")).toBe(false);
  });
});
