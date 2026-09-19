import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { appPresenceFromProbeError } from "../../src/apple/errors";
import { listVersions } from "../../src/apple/versionFinder";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { apiGet } from "../../src/api/client";
import i18n from "../../src/i18n";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn(),
}));

const LOOKUP_HOST = "uclient-api.itunes.apple.com";
const DISPATCH_HOST = "downloaddispatch.itunes.apple.com";

const account: Account = {
  email: "test@example.com",
  password: "secret",
  appleId: "test@example.com",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "1234567890",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
  pod: "25",
};

const app = { id: 1492142120, bundleID: "com.example.app", name: "Example" } as Software;

type Reply = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: [string, string][];
  body: string;
};

const reply = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: String(status),
  headers,
  rawHeaders: [],
  body,
});

const versionsDoc = (identifiers: number[], latest: number | string = identifiers[identifiers.length - 1]) =>
  buildPlist({
    pings: [],
    songList: [
      {
        URL: "https://iosapps.example.com/app.ipa",
        sinfs: [{ id: 0, sinf: "AAAA" }],
        metadata: {
          softwareVersionExternalIdentifiers: identifiers,
          softwareVersionExternalIdentifier: latest,
        },
      },
    ],
  });

const emptyDoc = () =>
  buildPlist({ pings: [], jingleDocType: "purchaseSuccess", jingleAction: "purchaseProduct", status: 0 });

const failureDoc = (failureType: string, customerMessage?: string) =>
  buildPlist({ failureType, ...(customerMessage ? { customerMessage } : {}) });

const lookupDoc = (externalId: string) =>
  JSON.stringify({ results: { "1492142120": { offers: [{ version: { externalId } }] } } });

type RequestOptions = { host: string; path: string; body?: string };

let downloadReplies: Reply[] = [];
let lookupReply = lookupDoc("891042628");

const allCalls = () => vi.mocked(appleRequest).mock.calls.map((call) => call[0] as RequestOptions);
const downloadCalls = () => allCalls().filter((options) => options.host !== LOOKUP_HOST);

describe("apple/versionFinder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    downloadReplies = [];
    lookupReply = lookupDoc("891042628");

    vi.mocked(apiGet).mockResolvedValue({ pins: [] });

    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.example",
      redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload`,
      updateEndpoint: `https://${DISPATCH_HOST}/up/updateProduct`,
    });

    vi.mocked(appleRequest).mockImplementation(async (options: RequestOptions) => {
      if (options.host === LOOKUP_HOST) {
        return reply(lookupReply);
      }
      const next = downloadReplies.shift();
      if (!next) {
        throw new Error("unexpected extra download request");
      }
      return next;
    });
  });

  it("returns the identifiers newest first, as the pickers render them", async () => {
    downloadReplies = [reply(versionsDoc([111, 222, 333]))];

    const result = await listVersions(account, app);

    expect(result.versions).toEqual(["333", "222", "111"]);
    expect(result.latestExternalVersionId).toBe("333");
    expect(downloadCalls()).toHaveLength(1);
  });

  it("uses the same download-product exchange as the download flow", async () => {
    downloadReplies = [reply(emptyDoc()), reply(versionsDoc([111, 222]))];

    const result = await listVersions(account, app);

    expect(result.versions).toEqual(["222", "111"]);

    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].host).toBe("p25-buy.itunes.apple.com");
    expect(calls[1].host).toBe(DISPATCH_HOST);
    // The fallback hop carries a pinned version resolved from the catalogue.
    expect(calls[1].path).toContain("/r/redownload");
    expect(calls[1].body).toContain("<key>appExtVrsId</key><string>891042628</string>");
  });

  it("bubbles the cookies the exchange refreshed", async () => {
    downloadReplies = [reply(versionsDoc([111]))];

    const result = await listVersions(account, app);

    expect(result.updatedCookies).toEqual([]);
  });

  it.each([["2034"], ["2042"]])("reports %s as an expired session", async (failureType) => {
    downloadReplies = [reply(failureDoc(failureType))];

    await expect(listVersions(account, app)).rejects.toThrow(
      i18n.t("errors.versions.passwordExpired"),
    );
    expect(downloadCalls()).toHaveLength(1);
  });

  it("reports 9610 as a missing license", async () => {
    downloadReplies = [reply(failureDoc("9610"))];

    await expect(listVersions(account, app)).rejects.toThrow(
      i18n.t("errors.versions.licenseRequired"),
    );
    expect(downloadCalls()).toHaveLength(1);
  });

  it("treats 5002 as a plain failure, not an expired session", async () => {
    // ipatool's ListVersions only classifies 2034/2042 as session failures, so
    // 5002 must reach the generic branch rather than the token-expired one.
    downloadReplies = [reply(failureDoc("5002"))];

    const error = await listVersions(account, app).catch((e: Error) => e);

    expect((error as Error).message).toBe(
      i18n.t("errors.versions.failed", { failureType: "5002" }),
    );
    expect((error as Error).message).not.toBe(i18n.t("errors.versions.passwordExpired"));
    expect(downloadCalls()).toHaveLength(1);
  });

  it("prefers Apple's own message when it accompanies no items", async () => {
    downloadReplies = [reply(failureDoc("startupFailure", "This app is not available"))];

    await expect(listVersions(account, app)).rejects.toThrow(/This app is not available/);
  });

  it("fails when the reply carries no version identifiers", async () => {
    downloadReplies = [
      reply(
        buildPlist({
          pings: [],
          songList: [{ URL: "https://x/app.ipa", metadata: { bundleShortVersionString: "1.0" } }],
        }),
      ),
    ];

    await expect(listVersions(account, app)).rejects.toThrow();
  });

  it("fails when the exchange yields no item at all", async () => {
    // volumeStore empty, no redownload host advertised by the bag.
    vi.mocked(fetchBag).mockResolvedValue({ authURL: "https://auth.example" });
    downloadReplies = [reply(emptyDoc())];

    await expect(listVersions(account, app)).rejects.toThrow();
    expect(downloadCalls()).toHaveLength(1);
  });

  it("reads an item-less answer as a missing app", async () => {
    // Nothing to serve and no failure type: the shape an App ID the storefront
    // and the account both disown produces, so the caller may conclude that
    // nothing can be fetched for it.
    vi.mocked(fetchBag).mockResolvedValue({ authURL: "https://auth.example" });
    downloadReplies = [reply(emptyDoc())];

    const error = await listVersions(account, app).catch((e: unknown) => e);

    expect(appPresenceFromProbeError(error)).toBe("missing");
  });

  it("reads Apple's failure-free message as a missing app", async () => {
    downloadReplies = [reply(buildPlist({ customerMessage: "This item is not available" }))];

    const error = await listVersions(account, app).catch((e: unknown) => e);

    expect(appPresenceFromProbeError(error)).toBe("missing");
    expect((error as Error).message).toBe("This item is not available");
  });

  it("keeps a version that cannot be pinned anywhere open-ended", async () => {
    // No catalogue offer and no recorded pin: no build can be named yet, but
    // that is not proof of a missing app — a known version id can still serve
    // a delisted app, so the id stays usable.
    const tvosApp = { ...app, platform: "tvos" } as Software;
    lookupReply = JSON.stringify({ results: { "1492142120": { offers: [] } } });
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });

    const error = await listVersions(account, tvosApp).catch((e: unknown) => e);

    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
    expect((error as Error).message).toBe(
      i18n.t("errors.download.missingVersion"),
    );
  });

  it.each([["2034"], ["2042"], ["1008"], ["9610"], ["2001"], ["2059"], ["-128"], ["5002"], ["2019"]])(
    "treats %s as open-ended: Apple did not answer about the app",
    async (failureType) => {
      downloadReplies = [reply(failureDoc(failureType, "Your account is not authorized"))];

      const error = await listVersions(account, app).catch((e: unknown) => e);

      expect(appPresenceFromProbeError(error)).toBe("inconclusive");
    },
  );

  it("reads any other failure type as a missing app", async () => {
    // Apple answered a request it recognised and would not serve the item.
    downloadReplies = [reply(failureDoc("5001", "Item not available"))];

    const error = await listVersions(account, app).catch((e: unknown) => e);

    expect(appPresenceFromProbeError(error)).toBe("missing");
  });

  it("keeps a transport failure open-ended", async () => {
    // Nothing reached Apple about this id, so nothing is concluded about it.
    vi.mocked(appleRequest).mockImplementation(async (options: RequestOptions) => {
      if (options.host === LOOKUP_HOST) return reply(lookupReply);
      throw new TypeError("fetch failed");
    });

    const error = await listVersions(account, app).catch((e: unknown) => e);

    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
  });

  it("keeps a reply that carried a product but no identifiers open-ended", async () => {
    // Apple served an item, so the app exists — the payload just cannot be used.
    downloadReplies = [
      reply(
        buildPlist({
          pings: [],
          songList: [
            {
              URL: "https://x/app.ipa",
              metadata: { bundleShortVersionString: "1.0" },
            },
          ],
        }),
      ),
    ];

    const error = await listVersions(account, app).catch((e: unknown) => e);

    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
  });

  it("leaves the latest pointer undefined when Apple omits it", async () => {
    downloadReplies = [
      reply(
        buildPlist({
          pings: [],
          songList: [
            {
              URL: "https://x/app.ipa",
              metadata: { softwareVersionExternalIdentifiers: [111, 222] },
            },
          ],
        }),
      ),
    ];

    const result = await listVersions(account, app);

    expect(result.versions).toEqual(["222", "111"]);
    expect(result.latestExternalVersionId).toBeUndefined();
  });

  it("uses a caller-provided version id as the pin and skips the catalogue", async () => {
    const tvosApp = { ...app, platform: "tvos" } as Software;
    downloadReplies = [reply(versionsDoc([111, 222]))];

    const result = await listVersions(account, tvosApp, "777888999");

    expect(result.versions).toEqual(["222", "111"]);
    expect(allCalls().some((options) => options.host === LOOKUP_HOST)).toBe(false);
    expect(downloadCalls()).toHaveLength(1);
    expect(downloadCalls()[0].body).toContain(
      "<key>externalVersionId</key><string>777888999</string>",
    );
  });

  it("falls back to the recorded pin when the catalogue cannot name a version", async () => {
    const tvosApp = { ...app, platform: "tvos" } as Software;
    lookupReply = JSON.stringify({ results: { "1492142120": { offers: [] } } });
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "tvos", versionId: "999888" }],
    });
    downloadReplies = [reply(versionsDoc([111, 222]))];

    const result = await listVersions(account, tvosApp);

    expect(result.versions).toEqual(["222", "111"]);
    expect(downloadCalls()[0].body).toContain(
      "<key>externalVersionId</key><string>999888</string>",
    );
  });

  it("reports the missing pin when neither the catalogue nor the store has one", async () => {
    const tvosApp = { ...app, platform: "tvos" } as Software;
    lookupReply = JSON.stringify({ results: { "1492142120": { offers: [] } } });
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });

    await expect(listVersions(account, tvosApp)).rejects.toThrow(
      i18n.t("errors.download.missingVersion"),
    );
    expect(downloadCalls()).toHaveLength(0);
  });

  it("guesses the platform pin from the ids adjacent to the newest iOS one", async () => {
    // A bare delisted tvOS app with nothing recorded: the neighbours of the
    // newest iOS build are probed, nearest first, and the first one Apple
    // serves becomes the pin.
    const tvosApp = {
      ...app,
      platform: "tvos",
      metadataSource: "bare",
    } as Software;
    lookupReply = JSON.stringify({ results: { "1492142120": { offers: [] } } });
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });
    downloadReplies = [
      reply(versionsDoc([111, 222, 333])), // the iOS list: newest is 333
      reply(failureDoc("9610")), //         334 — not served
      reply(versionsDoc([444])), //         332 — served
      reply(failureDoc("9610")), //         335
      reply(failureDoc("9610")), //         331
      reply(failureDoc("9610")), //         336
      reply(failureDoc("9610")), //         330 — the batch runs six at a time
      reply(versionsDoc([777])), //         the tvOS list, pinned to the guess
    ];

    const result = await listVersions(account, tvosApp);

    expect(result.versions).toEqual(["777"]);
    const pinned = downloadCalls()
      .slice(1)
      .map(
        (call) =>
          /<key>externalVersionId<\/key><string>(\d+)<\/string>/.exec(
            call.body ?? "",
          )?.[1],
      );
    // Nearest first, alternating direction…
    expect(pinned.slice(0, 6)).toEqual([
      "334",
      "332",
      "335",
      "331",
      "336",
      "330",
    ]);
    // …never the iOS ids themselves…
    expect(pinned).not.toContain("333");
    // …and the list exchange runs on the neighbour that was served.
    expect(pinned[6]).toBe("332");
  });

  it("gives up when no neighbour of the newest iOS id is served", async () => {
    const tvosApp = {
      ...app,
      platform: "tvos",
      metadataSource: "bare",
    } as Software;
    lookupReply = JSON.stringify({ results: { "1492142120": { offers: [] } } });
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });
    downloadReplies = [
      reply(versionsDoc([111, 222, 333])),
      // Six steps each way, six probes at a time — none of them is served.
      ...Array.from({ length: 12 }, () => reply(failureDoc("9610"))),
    ];

    await expect(listVersions(account, tvosApp)).rejects.toThrow(
      i18n.t("errors.download.missingVersion"),
    );
    expect(downloadCalls()).toHaveLength(13);
  });

  it("keeps the raw storefront failure out of the caller's message", async () => {
    // A delisted id's visionOS/macOS storefront page is gone (404): the raw
    // "version lookup returned 404" text must not reach the caller — the same
    // clean missing-version failure the other platforms raise is used instead.
    const visionApp = { ...app, platform: "visionos" } as Software;
    vi.mocked(appleRequest).mockImplementation(
      async (options: RequestOptions) => {
        if (options.host === "apps.apple.com") return reply("", 404);
        return reply(lookupReply);
      },
    );
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });

    const error = await listVersions(account, visionApp).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toBe(
      i18n.t("errors.download.missingVersion"),
    );
    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
    // Only the storefront lookup went out; the exchange itself never started.
    expect(downloadCalls()).toHaveLength(1);
    expect(downloadCalls()[0].host).toBe("apps.apple.com");
  });
});
