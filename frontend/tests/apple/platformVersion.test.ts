import { describe, expect, it, vi, beforeEach } from "vitest";

// The lookup rides libcurl through `request`, which only runs under jsdom with
// a wisp tunnel; the catalogue transport is mocked out here so the platform
// routing can be asserted directly.
const appleRequest = vi.fn();
vi.mock("../../src/apple/request", () => ({
  appleRequest: (...args: unknown[]) => appleRequest(...args),
}));

import {
  lookupLatestExternalVersionId,
  lookupLatestMacOSVersionId,
} from "../../src/apple/platformVersion";

function replyWith(externalId: number | string) {
  appleRequest.mockResolvedValue({
    status: 200,
    body: JSON.stringify({
      results: {
        "1492142120": {
          offers: [{ version: { externalId } }],
        },
      },
    }),
  });
}

function storefrontBody(json: unknown): string {
  return `<script id="serialized-server-data">${JSON.stringify(json)}</script>`;
}

describe("lookupLatestExternalVersionId", () => {
  beforeEach(() => {
    appleRequest.mockClear();
  });

  it("pins the version from the enterprise catalogue by default", async () => {
    replyWith(818970197);

    await lookupLatestExternalVersionId(1492142120, "US");

    const [options] = appleRequest.mock.calls.at(-1) as [
      { path: string },
    ];
    const query = new URLSearchParams(options.path.split("?")[1]);
    expect(query.get("platform")).toBe("enterprisestore");
    expect(query.get("id")).toBe("1492142120");
  });

  it("routes tvOS through Apple's Apple TV catalogue", async () => {
    replyWith(818970197);

    await lookupLatestExternalVersionId(1492142120, "US", "tvos");

    const [options] = appleRequest.mock.calls.at(-1) as [
      { path: string },
    ];
    expect(
      new URLSearchParams(options.path.split("?")[1]).get("platform"),
    ).toBe("atv9");
  });

  it("routes visionOS through the storefront product page, not the MDM catalogue", async () => {
    const json = {
      purchaseConfiguration: {
        metricsPlatformDisplayStyle: "vision",
        appPlatforms: ["vision"],
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValue({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "visionos"),
    ).resolves.toBe("818970197");

    const [options] = appleRequest.mock.calls.at(-1) as [
      { host: string; path: string },
    ];
    expect(options.host).toBe("apps.apple.com");
    expect(options.path).toContain("/us/app/id1492142120");
    expect(options.path).toContain("platform=vision");
  });

  it("returns undefined for macOS (handled by lookupLatestMacOSVersionId)", async () => {
    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "macos"),
    ).resolves.toBeUndefined();
    expect(appleRequest).not.toHaveBeenCalled();
  });

  it("reads the version from the buy parameters when the offer lacks one", async () => {
    appleRequest.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        results: {
          "1492142120": {
            offers: [{ buyParams: "price=0&appExtVrsId=818970197" }],
          },
        },
      }),
    });

    await expect(
      lookupLatestExternalVersionId(1492142120, "US"),
    ).resolves.toBe("818970197");
  });

  it("forwards cookies to the MDM catalogue request", async () => {
    replyWith(818970197);
    const cookies = [{ name: "myinfo", value: "abc" }];

    await lookupLatestExternalVersionId(1492142120, "US", "tvos", cookies);

    const [options] = appleRequest.mock.calls.at(-1) as [
      { cookies?: typeof cookies },
    ];
    expect(options.cookies).toBe(cookies);
  });

  it("forwards cookies to the visionOS storefront request", async () => {
    const json = {
      purchaseConfiguration: {
        metricsPlatformDisplayStyle: "vision",
        appPlatforms: ["vision"],
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValue({
      status: 200,
      body: storefrontBody(json),
    });
    const cookies = [{ name: "myinfo", value: "abc" }];

    await lookupLatestExternalVersionId(1492142120, "US", "visionos", cookies);

    const [options] = appleRequest.mock.calls.at(-1) as [
      { cookies?: typeof cookies },
    ];
    expect(options.cookies).toBe(cookies);
  });
});

describe("lookupLatestMacOSVersionId", () => {
  beforeEach(() => {
    appleRequest.mockClear();
  });

  it("pins the version from the Mac storefront product page", async () => {
    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValue({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US", "com.example.app"),
    ).resolves.toBe("818970197");

    const [options] = appleRequest.mock.calls.at(-1) as [
      { host: string; path: string },
    ];
    expect(options.host).toBe("apps.apple.com");
    expect(options.path).toContain("/us/app/id1492142120");
    expect(options.path).toContain("platform=mac");
  });

  it("matches by bundle id when one is provided", async () => {
    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.other.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=999",
      },
    };
    appleRequest.mockResolvedValue({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US", "com.example.app"),
    ).rejects.toThrow("no external version id");
  });

  it("throws when the storefront has no macOS purchase configuration", async () => {
    appleRequest.mockResolvedValue({
      status: 200,
      body: storefrontBody({}),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("no external version id");
  });

  it("forwards cookies to the Mac storefront request", async () => {
    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValue({
      status: 200,
      body: storefrontBody(json),
    });
    const cookies = [{ name: "myinfo", value: "abc" }];

    await lookupLatestMacOSVersionId(
      1492142120,
      "US",
      "com.example.app",
      cookies,
    );

    const [options] = appleRequest.mock.calls.at(-1) as [
      { cookies?: typeof cookies },
    ];
    expect(options.cookies).toBe(cookies);
  });
});
