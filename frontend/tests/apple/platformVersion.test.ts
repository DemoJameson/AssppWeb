import { describe, expect, it, vi, beforeEach } from "vitest";

// The lookup rides libcurl through `request`, which only runs under jsdom with
// a wisp tunnel; the catalogue transport is mocked out here so the platform
// routing can be asserted directly.
const appleRequest = vi.fn();
vi.mock("../../src/apple/request", () => ({
  appleRequest: (...args: unknown[]) => appleRequest(...args),
}));

const apiGet = vi.fn();
vi.mock("../../src/api/client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
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

function pathOf(callIndex: number): string {
  const options = appleRequest.mock.calls[callIndex]?.[0] as
    | { path?: string }
    | undefined;
  return options?.path ?? "";
}

function redirectReply(location: string, status = 301) {
  return { status, headers: { location }, body: "" };
}

// Every lookup here resets both transports first: a test that leaves a reply
// queued or a settings mock in place must not decide what the next one sees.
beforeEach(() => {
  appleRequest.mockReset();
  apiGet.mockReset();
  apiGet.mockResolvedValue({ storefrontFallbackCountries: ["cn"] });
});

describe("lookupLatestExternalVersionId", () => {
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

  it("follows the canonical redirect on the visionOS storefront page", async () => {
    appleRequest.mockResolvedValueOnce(
      redirectReply(
        "https://apps.apple.com/cn/app/infuse/id1492142120?platform=vision",
      ),
    );

    const json = {
      purchaseConfiguration: {
        metricsPlatformDisplayStyle: "vision",
        appPlatforms: ["vision"],
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestExternalVersionId(1492142120, "CN", "visionos"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(pathOf(0)).toContain("/cn/app/id1492142120");
    expect(pathOf(0)).toContain("platform=vision");
    expect(pathOf(1)).toBe("/cn/app/infuse/id1492142120?platform=vision");
  });

  it("falls back to another storefront when the account's own visionOS page is redirected", async () => {
    // The same shape as macOS's fallback: from a mainland-China network the
    // account's own storefront is answered with a redirect to the CN one, so
    // the page must come from the fallback — after following its redirect.
    appleRequest.mockResolvedValueOnce(redirectReply("/cn", 302));
    appleRequest.mockResolvedValueOnce({ status: 200, body: storefrontBody({}) });
    appleRequest.mockResolvedValueOnce(
      redirectReply(
        "https://apps.apple.com/cn/app/infuse/id1492142120?platform=vision",
      ),
    );

    const json = {
      purchaseConfiguration: {
        metricsPlatformDisplayStyle: "vision",
        appPlatforms: ["vision"],
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestExternalVersionId(1492142120, "US", "visionos"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(4);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
    expect(pathOf(1)).toBe("/cn");
    expect(pathOf(2)).toContain("/cn/app/id1492142120");
    expect(pathOf(3)).toBe("/cn/app/infuse/id1492142120?platform=vision");
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

  it("asks the account's own storefront first and stops when it answers", async () => {
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

    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
  });

  it("falls back to another storefront when the account's own Mac page is redirected", async () => {
    // The shape a mainland-China network gets for any non-CN storefront path:
    // Apple answers with a redirect instead of the product page — 302 to the
    // CN storefront, whose own canonical redirect then lands on the storefront
    // home page — so the account sees no Mac offer for an app that has one.
    appleRequest.mockResolvedValueOnce(redirectReply("/cn", 302));
    appleRequest.mockResolvedValueOnce({ status: 200, body: storefrontBody({}) });

    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce(
      redirectReply("https://apps.apple.com/cn/app/xcode/id1492142120?mt=12"),
    );
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US", "com.example.app"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(4);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
    expect(pathOf(1)).toBe("/cn");
    expect(pathOf(2)).toContain("/cn/app/id1492142120");
    expect(pathOf(2)).toContain("platform=mac");
    expect(pathOf(3)).toBe("/cn/app/xcode/id1492142120?mt=12");
  });

  it("falls back when the account's own storefront has no Mac offer", async () => {
    appleRequest.mockResolvedValueOnce({ status: 200, body: storefrontBody({}) });

    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce(
      redirectReply("/cn/app/xcode/id1492142120?mt=12"),
    );
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US", "com.example.app"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(pathOf(1)).toContain("/cn/app/id1492142120");
    expect(pathOf(2)).toBe("/cn/app/xcode/id1492142120?mt=12");
  });

  it("reports the account's own storefront failure when no storefront answers", async () => {
    // The own failure must survive the fallback attempt: it is the answer
    // about the app the caller asked about, and it is the one kept.
    appleRequest.mockResolvedValueOnce({ status: 200, body: storefrontBody({}) });
    appleRequest.mockResolvedValueOnce({ status: 404, headers: {}, body: "" });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("no external version id");

    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it("does not retry the account's own storefront twice when it is already the fallback", async () => {
    appleRequest.mockResolvedValueOnce(
      redirectReply("/cn/app/xcode/id1492142120?mt=12"),
    );

    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "CN"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(pathOf(0)).toContain("/cn/app/id1492142120");
    expect(pathOf(1)).toBe("/cn/app/xcode/id1492142120?mt=12");
  });

  it("follows the canonical redirect on the account's own storefront", async () => {
    // Every slug-less app path is 301'd to its canonical URL; the lookup must
    // read the page at the end of that chain, not the redirect response.
    appleRequest.mockResolvedValueOnce(
      redirectReply("https://apps.apple.com/us/app/xcode/id1492142120?mt=12"),
    );

    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US", "com.example.app"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
    expect(pathOf(1)).toBe("/us/app/xcode/id1492142120?mt=12");
  });

  it("gives up when the storefront keeps redirecting", async () => {
    appleRequest.mockResolvedValue(redirectReply("/cn/app/loop"));

    await expect(
      lookupLatestMacOSVersionId(1492142120, "CN"),
    ).rejects.toThrow("redirected too many times");

    // One request per allowed hop, plus the one that trips the cap.
    expect(appleRequest).toHaveBeenCalledTimes(6);
  });

  it("refuses to follow a redirect off the storefront", async () => {
    appleRequest.mockResolvedValue(
      redirectReply("https://example.com/cn/app/id1492142120"),
    );

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("redirected off apps.apple.com");

    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect that leaves the storefront's scheme or port", async () => {
    // The next hop would carry the account's cookies, so the host name alone is
    // not enough to trust it: a downgrade and an odd port are refused too.
    appleRequest.mockResolvedValue(
      redirectReply("http://apps.apple.com/cn/app/id1492142120"),
    );

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("redirected off apps.apple.com");

    appleRequest.mockReset();
    appleRequest.mockResolvedValue(
      redirectReply("https://apps.apple.com:8443/cn/app/id1492142120"),
    );

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("redirected off apps.apple.com");
  });

  it("consults the storefronts the server configures", async () => {
    vi.mocked(apiGet).mockResolvedValue({ storefrontFallbackCountries: ["jp"] });

    appleRequest.mockResolvedValueOnce({ status: 404, headers: {}, body: "" });

    const json = {
      purchaseConfiguration: {
        appPlatforms: ["mac"],
        bundleId: "com.example.app",
        buyParams: "salableAdamId=1492142120&appExtVrsId=818970197",
      },
    };
    appleRequest.mockResolvedValueOnce(
      redirectReply("/jp/app/xcode/id1492142120?mt=12"),
    );
    appleRequest.mockResolvedValueOnce({
      status: 200,
      body: storefrontBody(json),
    });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US", "com.example.app"),
    ).resolves.toBe("818970197");

    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
    expect(pathOf(1)).toContain("/jp/app/id1492142120");
    expect(pathOf(2)).toBe("/jp/app/xcode/id1492142120?mt=12");
  });

  it("does not fall back when the server configures none", async () => {
    vi.mocked(apiGet).mockResolvedValue({ storefrontFallbackCountries: [] });
    appleRequest.mockResolvedValue({ status: 404, headers: {}, body: "" });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("returned 404");

    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
  });

  it("leaves the fallback out when the server settings cannot be read", async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error("offline"));
    appleRequest.mockResolvedValue({ status: 404, headers: {}, body: "" });

    await expect(
      lookupLatestMacOSVersionId(1492142120, "US"),
    ).rejects.toThrow("returned 404");

    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
  });

  it("asks the account's own storefront without waiting for the server settings", async () => {
    // The fallback list is only needed once the account's own attempt has come
    // up short, so a settings request that never answers must not hold up a
    // lookup that storefront can answer by itself.
    vi.mocked(apiGet).mockImplementation(
      () => new Promise<never>(() => undefined),
    );

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

    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(pathOf(0)).toContain("/us/app/id1492142120");
  });

  it("reads the server settings again for the next lookup", async () => {
    // Read per lookup, not cached past it: an operator change applies to the
    // next lookup without a rebuild, and a read that never answers cannot hold
    // the ones after it.
    appleRequest.mockResolvedValue({ status: 404, headers: {}, body: "" });

    await lookupLatestMacOSVersionId(1492142120, "US").catch(() => undefined);
    await lookupLatestMacOSVersionId(1492142120, "US").catch(() => undefined);

    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
