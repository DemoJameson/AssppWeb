import { describe, expect, it } from "vitest";
import { gravatarUrl, md5 } from "../../src/utils/avatar";

describe("md5", () => {
  it("matches the RFC 1321 test vectors", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });

  it("digests UTF-8 input", () => {
    expect(md5("你好")).toBe("7eca689f0d3389d9dea66ae112e5cfd7");
  });
});

describe("gravatarUrl", () => {
  it("addresses the avatar by the lowercase, trimmed email", () => {
    expect(gravatarUrl("  MyEmailAddress@Example.COM ")).toBe(
      "https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=96&d=404",
    );
  });

  it("honours the requested size", () => {
    expect(gravatarUrl("myemailaddress@example.com", 192)).toContain("?s=192");
  });

  it.each(["   ", "13800138000", "+91 98765 43210"])(
    "returns null for %j — nothing hashes but an email",
    (identifier) => {
      expect(gravatarUrl(identifier)).toBeNull();
    },
  );
});
