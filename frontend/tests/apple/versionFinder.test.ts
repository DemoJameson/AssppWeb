import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { listVersions } from "../../src/apple/versionFinder";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import i18n from "../../src/i18n";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
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

const allCalls = () => vi.mocked(appleRequest).mock.calls.map((call) => call[0] as RequestOptions);
const downloadCalls = () => allCalls().filter((options) => options.host !== LOOKUP_HOST);

describe("apple/versionFinder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    downloadReplies = [];

    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.example",
      redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload`,
      updateEndpoint: `https://${DISPATCH_HOST}/up/updateProduct`,
    });

    vi.mocked(appleRequest).mockImplementation(async (options: RequestOptions) => {
      if (options.host === LOOKUP_HOST) {
        return reply(lookupDoc("891042628"));
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
});
