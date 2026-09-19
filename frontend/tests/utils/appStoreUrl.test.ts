import { describe, it, expect } from "vitest";
import { appIdFromStoreUrl } from "../../src/utils/appStoreUrl";

describe("appIdFromStoreUrl", () => {
  it("lifts the id out of a localized store link", () => {
    expect(
      appIdFromStoreUrl(
        "https://apps.apple.com/cn/app/senplayer-%E5%85%A8%E8%83%BD%E8%A7%86%E9%A2%91%E6%92%AD%E6%94%BE%E5%99%A8-%E7%BD%91%E7%9B%98%E7%9B%B4%E8%BF%9E/id6443975850",
      ),
    ).toBe("6443975850");
  });

  it("handles us links, itunes links, query strings, and scheme-less pastes", () => {
    expect(
      appIdFromStoreUrl("https://apps.apple.com/us/app/foo/id123456?mt=8"),
    ).toBe("123456");
    expect(appIdFromStoreUrl("https://itunes.apple.com/app/id42")).toBe("42");
    expect(appIdFromStoreUrl("apps.apple.com/cn/app/id6443975850")).toBe(
      "6443975850",
    );
  });

  it("rejects values that are not Apple store links", () => {
    expect(appIdFromStoreUrl("com.example.app")).toBeUndefined();
    expect(
      appIdFromStoreUrl("https://apps.apple.com/cn/app/no-id-here"),
    ).toBeUndefined();
    expect(appIdFromStoreUrl("https://example.com/id123")).toBeUndefined();
    expect(appIdFromStoreUrl("6443975850")).toBeUndefined();
    expect(appIdFromStoreUrl("")).toBeUndefined();
  });
});
