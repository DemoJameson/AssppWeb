import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { getDownloadInfo } from "../../src/apple/download";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { apiGet } from "../../src/api/client";
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

const app = {
  id: 1492142120,
  bundleID: "com.example.app",
  name: "Example",
} as Software;

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

/** Apple's "empty" reply: a well-formed plist with nothing in it to download. */
const purchaseDoc = () =>
  buildPlist({
    pings: [],
    jingleDocType: "purchaseSuccess",
    jingleAction: "purchaseProduct",
    status: 0,
  });

/** A real failure answer, carrying a failureType. */
const failureDoc = (failureType: string, customerMessage?: string) =>
  buildPlist({
    failureType,
    ...(customerMessage ? { customerMessage } : {}),
  });

/** Apple's availability message, which is not a failureType. */
const unavailableDoc = () => buildPlist({ pings: [], customerMessage: "No Longer Available" });

/** redownload coming up empty-handed with an HTTP 500. */
const emptyServerError = () =>
  reply("", 500, { "content-type": "text/xml" });

const downloadDoc = (metadata: Record<string, unknown> = {}) =>
  buildPlist({
    pings: [],
    songList: [
      {
        URL: "https://iosapps.example.com/app.ipa",
        sinfs: [{ id: 0, sinf: "AAAA" }],
        metadata: { bundleShortVersionString: "1.2.3", bundleVersion: "123", ...metadata },
      },
    ],
  });

/** What updateProduct answers: one item that must identify itself. */
const updateDoc = (versionId: string, overrides: Record<string, unknown> = {}) =>
  downloadDoc({
    itemId: 1492142120,
    softwareVersionExternalIdentifier: versionId,
    softwareVersionBundleId: "com.example.app",
    ...overrides,
  });

const lookupDoc = (externalId: string | number) =>
  JSON.stringify({
    results: { "1492142120": { offers: [{ version: { externalId } }] } },
  });

const offersMissingDoc = () => JSON.stringify({ results: { "1492142120": { offers: [] } } });

type RequestOptions = { host: string; path: string; body?: string };

let downloadReplies: Reply[] = [];
let lookupBody = lookupDoc("891042628");

const allCalls = () =>
  vi.mocked(appleRequest).mock.calls.map((call) => call[0] as RequestOptions);

const downloadCalls = () => allCalls().filter((options) => options.host !== LOOKUP_HOST);

const lookupCalls = () => allCalls().filter((options) => options.host === LOOKUP_HOST);

const withBag = (endpoints: { redownloadEndpoint?: string; updateEndpoint?: string }) =>
  vi.mocked(fetchBag).mockResolvedValue({ authURL: "https://auth.example", ...endpoints });

describe("apple/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    downloadReplies = [];
    lookupBody = lookupDoc("891042628");

    vi.mocked(apiGet).mockResolvedValue({ pins: [] });

    withBag({
      redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload`,
      updateEndpoint: `https://${DISPATCH_HOST}/up/updateProduct`,
    });

    vi.mocked(appleRequest).mockImplementation(async (options: RequestOptions) => {
      if (options.host === LOOKUP_HOST) {
        return reply(lookupBody);
      }
      const next = downloadReplies.shift();
      if (!next) {
        throw new Error("unexpected extra download request");
      }
      return next;
    });
  });

  it("takes volumeStore's answer as-is when it carries a download item", async () => {
    downloadReplies = [reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(output.bundleShortVersionString).toBe("1.2.3");
    expect(output.bundleVersion).toBe("123");

    const calls = downloadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe("p25-buy.itunes.apple.com");
    expect(calls[0].path).toContain("/volumeStoreDownloadProduct?guid=aabbccddeeff");
  });

  it("sends the payload ipatool sends, with salableAdamId as an integer", async () => {
    downloadReplies = [reply(downloadDoc())];

    await getDownloadInfo(account, app);

    const body = downloadCalls()[0].body!;
    expect(body).toContain("<key>creditDisplay</key><string></string>");
    expect(body).toContain("<key>guid</key><string>aabbccddeeff</string>");
    expect(body).toContain("<key>salableAdamId</key><integer>1492142120</integer>");
    expect(body).toContain("<key>serialNumber</key><string>0</string>");
    expect(body).not.toContain("externalVersionId");
  });

  it("falls back to the bag's redownload host when volumeStore serves no item", async () => {
    downloadReplies = [reply(purchaseDoc()), reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");

    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].host).toBe("p25-buy.itunes.apple.com");
    expect(calls[1].host).toBe(DISPATCH_HOST);
    expect(calls[1].path).toContain("/r/redownload");
    // Both hops carry the serial number slot; only the dispatch hop names the
    // version appExtVrsId, and it carries the id pinned from the catalogue.
    expect(calls[0].body).toContain("<key>serialNumber</key>");
    expect(calls[1].body).toContain("<key>serialNumber</key>");
    expect(calls[1].body).toContain("<key>appExtVrsId</key><string>891042628</string>");
  });

  it("pins the version from the catalogue in the account's own country", async () => {
    downloadReplies = [reply(purchaseDoc()), reply(downloadDoc())];

    await getDownloadInfo(account, app);

    const lookups = lookupCalls();
    expect(lookups).toHaveLength(1);
    expect(lookups[0].path).toContain("id=1492142120");
    expect(lookups[0].path).toContain("cc=us");
    expect(lookups[0].path).toContain("platform=enterprisestore");
  });

  it("keeps a caller-provided version and never consults the catalogue", async () => {
    downloadReplies = [reply(purchaseDoc()), reply(downloadDoc())];

    await getDownloadInfo(account, app, "987654321");

    expect(lookupCalls()).toHaveLength(0);

    const calls = downloadCalls();
    expect(calls[0].body).toContain("<key>externalVersionId</key><string>987654321</string>");
    expect(calls[1].body).toContain("<key>appExtVrsId</key><string>987654321</string>");
  });

  it("reports what volumeStore said when the bag advertises no redownload host", async () => {
    withBag({});
    downloadReplies = [reply(purchaseDoc())];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/\[HTTP 200\]/);
    expect(downloadCalls()).toHaveLength(1);
  });

  it("falls back to updateProduct when redownload answers an empty HTTP 500", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      emptyServerError(),
      reply(updateDoc("891042628")),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");

    const calls = downloadCalls();
    expect(calls).toHaveLength(3);
    expect(calls[2].host).toBe(DISPATCH_HOST);
    expect(calls[2].path).toContain("/up/updateProduct");
    expect(calls[2].body).toContain("<key>appExtVrsId</key><string>891042628</string>");
  });

  it("falls back to updateProduct when redownload reports the app unavailable", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      reply(unavailableDoc()),
      reply(updateDoc("891042628")),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls()[2].path).toContain("/up/updateProduct");
  });

  it("does not fall back to updateProduct for a redownload failure that has a failureType", async () => {
    downloadReplies = [reply(purchaseDoc()), reply(failureDoc("9610"))];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(downloadCalls()).toHaveLength(2);
  });

  it("surfaces the empty 500 when the bag advertises no update host", async () => {
    withBag({ redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload` });
    downloadReplies = [reply(purchaseDoc()), emptyServerError()];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/HTTP 500/);
    expect(downloadCalls()).toHaveLength(2);
  });

  it("rejects an update reply that describes a different app or version", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      emptyServerError(),
      reply(updateDoc("891042628", { itemId: 999 })),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(downloadCalls()).toHaveLength(3);
  });

  it("rejects an update reply with the wrong bundle identifier", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      emptyServerError(),
      reply(updateDoc("891042628", { softwareVersionBundleId: "com.other.app" })),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
  });

  it("treats failureType 5002 as a session failure rather than another endpoint's job", async () => {
    // ipatool groups 5002 with the password-token failures, so it must not be
    // mistaken for "this host serves nothing" and retried elsewhere.
    downloadReplies = [reply(failureDoc("5002", "An unknown error has occurred"))];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(downloadCalls()).toHaveLength(1);
  });

  it("treats failureType 2034 and 2042 as session failures", async () => {
    downloadReplies = [reply(failureDoc("2034"))];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(downloadCalls()).toHaveLength(1);
  });

  it("reports 9610 as a missing license", async () => {
    downloadReplies = [reply(failureDoc("9610"))];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(downloadCalls()).toHaveLength(1);
  });

  it("prefers Apple's own message over the raw failure type", async () => {
    downloadReplies = [reply(failureDoc("startupFailure", "This app is not available"))];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/This app is not available/);
  });

  it("reports a non-plist reply with its status and snippet", async () => {
    downloadReplies = [reply("<html><body>Service Unavailable</body></html>", 503, {
      "content-type": "text/html",
    })];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/HTTP 503/);
    expect(downloadCalls()).toHaveLength(1);
  });

  it("follows a redirect before interpreting the body", async () => {
    downloadReplies = [
      reply("", 302, {
        location: `https://p30-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff&Pod=30`,
      }),
      reply(downloadDoc()),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls()[1].host).toBe("p30-buy.itunes.apple.com");
  });

  it("refuses a redownload host the bag does not legitimately advertise", async () => {
    withBag({ redownloadEndpoint: "https://downloaddispatch.evil.example/r/redownload" });
    downloadReplies = [reply(purchaseDoc())];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/evil\.example/);
    expect(downloadCalls()).toHaveLength(1);
  });

  it("fails when the catalogue cannot name a version for the dispatch fallback", async () => {
    lookupBody = offersMissingDoc();
    downloadReplies = [reply(purchaseDoc())];

    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    // The redownload hop is never sent without a version.
    expect(downloadCalls()).toHaveLength(1);
  });

  it("reports the external version id of the build Apple served", async () => {
    downloadReplies = [
      reply(downloadDoc({ softwareVersionExternalIdentifier: 891042628 })),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.externalVersionId).toBe("891042628");
  });

  it("pins the dispatch fallback with the recorded pin when the catalogue cannot name one", async () => {
    lookupBody = offersMissingDoc();
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "ios", versionId: "555444" }],
    });
    downloadReplies = [reply(purchaseDoc()), reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain(
      "<key>appExtVrsId</key><string>555444</string>",
    );
  });
});
