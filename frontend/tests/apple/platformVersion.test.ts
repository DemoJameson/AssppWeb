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

function successReply(externalId: number | string) {
  return {
    status: 200,
    body: JSON.stringify({
      results: {
        "1492142120": { offers: [{ version: { externalId } }] },
      },
    }),
  };
}

function noAppReply() {
  return { status: 200, body: JSON.stringify({ results: {} }) };
}

function noOffersReply() {
  return {
    status: 200,
    body: JSON.stringify({
      results: { "1492142120": { offers: [] } },
    }),
  };
}

function buyParamsReply(appExtVrsId: string) {
  return {
    status: 200,
    body: JSON.stringify({
      results: {
        "1492142120": {
          offers: [{ buyParams: `price=0&appExtVrsId=${appExtVrsId}` }],
        },
      },
    }),
  };
}

function queryOf(callIndex: number): URLSearchParams {
  const options = appleRequest.mock.calls[callIndex]?.[0] as
    | { path?: string }
    | undefined;
  return new URLSearchParams(options?.path?.split("?")[1] ?? "");
}

describe("lookupLatestExternalVersionId", () => {
  beforeEach(() => {
    appleRequest.mockReset();
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

  it("consults only the enterprise catalogue when it answers", async () => {
    appleRequest.mockResolvedValueOnce(successReply(818970197));

    await expect(
      lookupLatestExternalVersionId(1492142120, "US"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(queryOf(0).get("platform")).toBe("enterprisestore");
    expect(queryOf(0).get("cc")).toBe("us");
  });

  it("falls back to the iphone catalogue when enterprise has no app", async () => {
    appleRequest.mockResolvedValueOnce(noAppReply());
    appleRequest.mockResolvedValueOnce(successReply(818970197));

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "ios"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(queryOf(0).get("platform")).toBe("enterprisestore");
    expect(queryOf(0).get("cc")).toBe("us");
    expect(queryOf(1).get("platform")).toBe("iphone");
    expect(queryOf(1).get("cc")).toBe("us");
  });

  it("walks enterprise → iphone → ipad when earlier catalogues come up empty", async () => {
    appleRequest.mockResolvedValueOnce(noOffersReply());
    appleRequest.mockResolvedValueOnce(noAppReply());
    appleRequest.mockResolvedValueOnce(successReply(818970197));

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "ipad"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(queryOf(0).get("platform")).toBe("enterprisestore");
    expect(queryOf(1).get("platform")).toBe("iphone");
    expect(queryOf(2).get("platform")).toBe("ipad");
  });

  it("throws naming the app, storefront and catalogues when every one is exhausted", async () => {
    appleRequest.mockResolvedValueOnce(noAppReply());
    appleRequest.mockResolvedValueOnce(noOffersReply());
    appleRequest.mockResolvedValueOnce(noAppReply());

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "ios"),
    ).rejects.toThrow(
      "app 1492142120 in storefront US (catalogs: enterprisestore, iphone, ipad)",
    );

    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when a catalogue returns HTTP 503 (no fallback)", async () => {
    appleRequest.mockResolvedValueOnce({ status: 503, body: "" });

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "ios"),
    ).rejects.toThrow("Version lookup returned 503");

    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("does not cascade for tvOS: a single atv9 answer is authoritative", async () => {
    appleRequest.mockResolvedValueOnce(noAppReply());

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "tvos"),
    ).rejects.toThrow("app 1492142120 in storefront US (catalogs: atv9)");

    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(queryOf(0).get("platform")).toBe("atv9");
  });

  it("reads a fallback catalogue's version from buy params", async () => {
    appleRequest.mockResolvedValueOnce(noAppReply());
    appleRequest.mockResolvedValueOnce(buyParamsReply("818970197"));

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "ios"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(queryOf(1).get("platform")).toBe("iphone");
  });

  it("cascades when no platform is passed (the default device class)", async () => {
    appleRequest.mockResolvedValueOnce(noOffersReply());
    appleRequest.mockResolvedValueOnce(successReply(818970197));

    await expect(
      lookupLatestExternalVersionId(1492142120, "US"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(queryOf(0).get("platform")).toBe("enterprisestore");
    expect(queryOf(1).get("platform")).toBe("iphone");
  });
});

describe("lookupLatestMacOSVersionId", () => {
  beforeEach(() => {
    appleRequest.mockReset();
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
