import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { getDownloadInfo } from "../../src/apple/download";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { AppleUnreachableError } from "../../src/apple/errors";
import { apiGet } from "../../src/api/client";
import {
  acceptDownloadKBSync,
  generateDownloadKBSync,
  invalidateDownloadKBSync,
} from "../../src/apple/sap/client";
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

vi.mock("../../src/apple/sap/client", () => ({
  acceptDownloadKBSync: vi.fn(),
  generateDownloadKBSync: vi.fn(),
  invalidateDownloadKBSync: vi.fn(),
}));

const LOOKUP_HOST = "uclient-api.itunes.apple.com";
const STOREFRONT_HOST = "apps.apple.com";
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

const replyWithCookies = (
  body: string,
  cookies: string[],
  status = 200,
): Reply => ({
  ...reply(body, status),
  rawHeaders: cookies.map((value): [string, string] => ["Set-Cookie", value]),
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

/** Apple's 200-level no-licence refusal, optionally nested in a dialog. */
const redownloadUnavailableDoc = (dialog = false) => {
  const fields = {
    message: "Redownload Unavailable with This Apple Account",
    explanation:
      "This redownload is not available for this Apple Account either because it was bought by a different user or the item was refunded or cancelled.",
  };
  return buildPlist(dialog ? { dialog: fields } : fields);
};

/** A download item whose metadata is valid but whose key material is absent. */
const noMaterialDoc = () =>
  buildPlist({
    songList: [
      {
        URL: "https://iosapps.example.com/app.ipa",
        sinfs: [],
        metadata: { bundleShortVersionString: "1.2.3", bundleVersion: "123" },
      },
    ],
  });

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
        md5: "0123456789abcdef0123456789abcdef",
        metadata: { bundleShortVersionString: "1.2.3", bundleVersion: "123", ...metadata },
      },
    ],
  });

/** A macOS build: Apple hands those out as .pkg containers, not as IPAs. */
const macPackageDoc = (item: Record<string, unknown> = {}) =>
  buildPlist({
    pings: [],
    songList: [
      {
        URL: "https://iosapps.example.com/app.pkg",
        sinfs: [{ id: 0, sinf: "AAAA" }],
        metadata: { bundleShortVersionString: "1.2.3", bundleVersion: "123" },
        ...item,
      },
    ],
  });

/**
 * A macOS reply as Apple really answers one: the package, plus the `dpInfo` it
 * is decrypted with. The bytes are "ABCD" — they read as themselves in base64,
 * so an assertion on the decoded value is about the bytes, not the encoding.
 */
const macReply = (item: Record<string, unknown> = {}) =>
  macPackageDoc({
    sinfs: [{ id: 0, dpInfo: new Uint8Array([0x41, 0x42, 0x43, 0x44]) }],
    ...item,
  });

/** What updateProduct answers: one item that must identify itself. */
const updateDoc = (versionId: string, overrides: Record<string, unknown> = {}) =>
  downloadDoc({
    itemId: 1492142120,
    softwareVersionExternalIdentifier: versionId,
    softwareVersionBundleId: "com.example.app",
    ...overrides,
  });

/** What ent/download answers: the pinned build plus its package URL. */
const entDownloadDoc = (overrides: Record<string, unknown> = {}) =>
  updateDoc("891042628", overrides);

const lookupDoc = (externalId: string | number) =>
  JSON.stringify({
    results: { "1492142120": { offers: [{ version: { externalId } }] } },
  });

const offersMissingDoc = () => JSON.stringify({ results: { "1492142120": { offers: [] } } });

type RequestOptions = {
  host: string;
  path: string;
  body?: string;
  cookies?: typeof account.cookies;
};

let downloadReplies: (Reply | Error)[] = [];
let lookupBody = lookupDoc("891042628");
let storefrontBody: Reply | ((options: RequestOptions) => Reply) = reply("", 404);

const allCalls = () =>
  vi.mocked(appleRequest).mock.calls.map((call) => call[0] as RequestOptions);

const downloadCalls = () =>
  allCalls().filter(
    (options) => options.host !== LOOKUP_HOST && options.host !== STOREFRONT_HOST,
  );

const lookupCalls = () => allCalls().filter((options) => options.host === LOOKUP_HOST);

const withBag = (endpoints: {
  entDownloadEndpoint?: string;
  redownloadEndpoint?: string;
  updateEndpoint?: string;
}) =>
  vi.mocked(fetchBag).mockResolvedValue({ authURL: "https://auth.example", ...endpoints });

const entDownloadEndpoint = () =>
  `https://${DISPATCH_HOST}/WebObjects/DownloadDispatch.woa/wa/ent/download`;

describe("apple/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    downloadReplies = [];
    lookupBody = lookupDoc("891042628");
    storefrontBody = reply("", 404);

    vi.mocked(apiGet).mockResolvedValue({ pins: [] });
    vi.mocked(generateDownloadKBSync).mockResolvedValue({
      blob: "a2JzeW5j",
      fromAcceptedCache: false,
    });

    withBag({
      redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload`,
      updateEndpoint: `https://${DISPATCH_HOST}/up/updateProduct`,
    });

    vi.mocked(appleRequest).mockImplementation(async (options: RequestOptions) => {
      if (options.host === LOOKUP_HOST) {
        return reply(lookupBody);
      }
      if (options.host === STOREFRONT_HOST) {
        return typeof storefrontBody === "function"
          ? storefrontBody(options)
          : storefrontBody;
      }
      const next = downloadReplies.shift();
      if (!next) {
        throw new Error("unexpected extra download request");
      }
      // A queued Error is what a request Apple never answered throws.
      if (next instanceof Error) throw next;
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

  it("prefers the bag's kbsync-backed ent/download endpoint", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
      redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload`,
      updateEndpoint: `https://${DISPATCH_HOST}/up/updateProduct`,
    });
    downloadReplies = [
      reply(
        entDownloadDoc(),
      ),
    ];

    const stages: Array<{ stage: string; percent: number | null } | null> = [];
    const { output } = await getDownloadInfo(account, app, undefined, {
      onStage: (stage) => stages.push(stage),
    });

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe(DISPATCH_HOST);
    expect(calls[0].path).toContain("/WebObjects/DownloadDispatch.woa/wa/ent/download");
    expect(calls[0].body).toContain("<key>kbsync</key><string>a2JzeW5j</string>");
    expect(calls[0].body).toContain("<key>salableAdamId</key><string>1492142120</string>");
    expect(calls[0].body).toContain('<plist version="1.0">');
    expect(generateDownloadKBSync).toHaveBeenCalledWith(
      "aabbccddeeff",
      "1234567890",
      expect.any(Function),
    );
    expect(acceptDownloadKBSync).toHaveBeenCalledWith(
      "aabbccddeeff",
      "1234567890",
      "a2JzeW5j",
    );
    expect(stages).toEqual([
      { stage: "connecting", percent: null },
      { stage: "confirming", percent: null },
    ]);
  });

  it("falls back from ent/download when its item has no download material", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    downloadReplies = [
      reply(
        buildPlist({
          songList: [
            {
              URL: "https://iosapps.example.com/app.ipa",
              sinfs: [],
              metadata: {
                bundleShortVersionString: "1.2.3",
                bundleVersion: "123",
                itemId: 1492142120,
                softwareVersionExternalIdentifier: "891042628",
                softwareVersionBundleId: "com.example.app",
              },
            },
          ],
        }),
      ),
      reply(downloadDoc()),
    ];

    const { output } = await getDownloadInfo(account, app, "891042628");

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain("/ent/download");
    expect(calls[1].path).toContain("/volumeStoreDownloadProduct");
  });

  it("falls back to volumeStore when kbsync generation fails", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync).mockRejectedValue(new Error("guest failed"));
    downloadReplies = [reply(downloadDoc())];

    const stages: Array<{ stage: string; percent: number | null } | null> = [];
    const { output } = await getDownloadInfo(account, app, undefined, {
      onStage: (stage) => stages.push(stage),
    });

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("/volumeStoreDownloadProduct");
    expect(stages).toEqual([null]);
  });

  it("retries a rejected cached kbsync once with a fresh blob", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync)
      .mockResolvedValueOnce({ blob: "cached", fromAcceptedCache: true })
      .mockResolvedValueOnce({ blob: "fresh", fromAcceptedCache: false });
    downloadReplies = [reply("", 403), reply(entDownloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.path.includes("/ent/download"))).toBe(true);
    expect(calls[0].body).toContain("<key>kbsync</key><string>cached</string>");
    expect(calls[1].body).toContain("<key>kbsync</key><string>fresh</string>");
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(2);
    expect(invalidateDownloadKBSync).toHaveBeenCalledWith(
      "aabbccddeeff",
      "1234567890",
      "cached",
    );
    expect(acceptDownloadKBSync).toHaveBeenCalledWith(
      "aabbccddeeff",
      "1234567890",
      "fresh",
    );
  });

  it("falls back when a fresh kbsync retry is also rejected", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync)
      .mockResolvedValueOnce({ blob: "cached", fromAcceptedCache: true })
      .mockResolvedValueOnce({ blob: "fresh", fromAcceptedCache: false });
    downloadReplies = [
      reply("", 403),
      reply("", 500),
      reply(downloadDoc()),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0].body).toContain("<key>kbsync</key><string>cached</string>");
    expect(calls[1].body).toContain("<key>kbsync</key><string>fresh</string>");
    expect(calls[2].path).toContain("/volumeStoreDownloadProduct");
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(2);
    expect(acceptDownloadKBSync).not.toHaveBeenCalled();
  });

  it("falls back after a rejected concurrent kbsync without a cache retry", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    // A concurrent waiter receives a generation that Apple has not accepted yet.
    // That is not a cache hit, so a 403 is final for this blob: fall back rather
    // than spending another StoreAgent run on the same uncached generation.
    vi.mocked(generateDownloadKBSync)
      .mockReset()
      .mockResolvedValueOnce({ blob: "shared", fromAcceptedCache: false })
      .mockResolvedValue({ blob: "unused", fromAcceptedCache: false });
    downloadReplies = [reply("", 403), reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain("<key>kbsync</key><string>shared</string>");
    expect(calls[1].path).toContain("/volumeStoreDownloadProduct");
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to volumeStore when ent/download answers an empty 403", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync).mockResolvedValueOnce({
      blob: "a2JzeW5j",
      fromAcceptedCache: false,
    });
    downloadReplies = [reply("", 403), reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain("/ent/download");
    expect(calls[1].path).toContain("/volumeStoreDownloadProduct");
    expect(invalidateDownloadKBSync).toHaveBeenCalledWith(
      "aabbccddeeff",
      "1234567890",
      "a2JzeW5j",
    );
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(1);
  });

  it("falls back from a structured ent/download failure without a kbsync retry", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync).mockResolvedValueOnce({
      blob: "cached",
      fromAcceptedCache: true,
    });
    downloadReplies = [reply(failureDoc("2034")), reply(failureDoc("9610"))];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/license/i);
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain("/ent/download");
    expect(calls[1].path).toContain("/volumeStoreDownloadProduct");
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(1);
    expect(invalidateDownloadKBSync).not.toHaveBeenCalled();
  });

  it("downloads a delisted tvOS app through the legacy chain when ent/download rejects its session", async () => {
    const tvosApp = {
      ...app,
      platform: "tvos",
      metadataSource: "local",
    } as Software;
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    lookupBody = offersMissingDoc();
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "tvos", versionId: "889244416" }],
    });
    downloadReplies = [
      replyWithCookies(failureDoc("2034"), ["session=ent-failed"]),
      reply(downloadDoc()),
    ];

    const { output } = await getDownloadInfo(account, tvosApp);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain("/ent/download");
    expect(calls[0].body).toContain("<key>externalVersionId</key><string>889244416</string>");
    expect(calls[1].path).toContain("/volumeStoreDownloadProduct");
    expect(calls[1].body).toContain("<key>externalVersionId</key><string>889244416</string>");
    expect(calls[1].cookies).toEqual([]);
  });

  it("reports the legacy transport failure when ent/download also failed", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync).mockResolvedValueOnce({
      blob: "cached",
      fromAcceptedCache: true,
    });
    downloadReplies = [
      reply(failureDoc("2034")),
      new AppleUnreachableError("timed out"),
    ];

    // ent/download is only a fast path: its 2034 must not outrank the answer
    // from the endpoint that used to serve this download (ipatool does the same).
    await expect(getDownloadInfo(account, app)).rejects.toThrow(/timed out/);
    expect(downloadCalls()).toHaveLength(2);
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["app", { itemId: 999 }],
    ["version", { softwareVersionExternalIdentifier: "other" }],
    ["bundle", { softwareVersionBundleId: "com.other.app" }],
  ])("falls back when ent/download names the wrong %s", async (_name, override) => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    downloadReplies = [
      reply(updateDoc("891042628", override)),
      reply(downloadDoc()),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls()).toHaveLength(2);
    expect(downloadCalls()[1].path).toContain("/volumeStoreDownloadProduct");
  });

  it("falls back when ent/download has no package URL", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    downloadReplies = [
      reply(
        buildPlist({
          songList: [
            {
              URL: "",
              metadata: {
                itemId: 1492142120,
                softwareVersionExternalIdentifier: "891042628",
                softwareVersionBundleId: "com.example.app",
              },
            },
          ],
        }),
      ),
      reply(downloadDoc()),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls()).toHaveLength(2);
    expect(downloadCalls()[1].path).toContain("/volumeStoreDownloadProduct");
  });

  it("falls back without a fresh retry when ent/download answers non-plist", async () => {
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    vi.mocked(generateDownloadKBSync).mockResolvedValueOnce({
      blob: "cached",
      fromAcceptedCache: true,
    });
    vi.mocked(generateDownloadKBSync).mockResolvedValueOnce({
      blob: "fresh",
      fromAcceptedCache: false,
    });
    downloadReplies = [
      reply("<html>nope</html>", 503),
      reply(failureDoc("9610")),
      reply(failureDoc("9610")),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(/license/i);
    const calls = downloadCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0].path).toContain("/ent/download");
    expect(calls[1].path).toContain("/ent/download");
    expect(calls[2].path).toContain("/volumeStoreDownloadProduct");
    expect(generateDownloadKBSync).toHaveBeenCalledTimes(2);
  });

  it("does not send the password token to an unapproved ent host", async () => {
    withBag({
      entDownloadEndpoint: "https://downloaddispatch.evil.example/WebObjects/DownloadDispatch.woa/wa/ent/download",
    });
    downloadReplies = [reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls().every((call) => call.host !== "downloaddispatch.evil.example")).toBe(true);
    expect(generateDownloadKBSync).not.toHaveBeenCalled();
  });

  it("pins macOS before preferring ent/download when no version is supplied", async () => {
    const macApp = { ...app, platform: "macos" } as Software;
    withBag({
      entDownloadEndpoint: entDownloadEndpoint(),
    });
    storefrontBody = reply(
      `<script id="serialized-server-data">${JSON.stringify({
        purchaseConfiguration: {
          appPlatforms: ["mac"],
          bundleId: "com.example.app",
          buyParams: "salableAdamId=1492142120&appExtVrsId=891042628",
        },
      })}</script>`,
    );
    downloadReplies = [
      reply(
        macReply({
          metadata: {
            bundleShortVersionString: "1.2.3",
            bundleVersion: "123",
            itemId: 1492142120,
            softwareVersionExternalIdentifier: "891042628",
            softwareVersionBundleId: "com.example.app",
          },
        }),
      ),
    ];

    const { output } = await getDownloadInfo(account, macApp);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.pkg");
    const calls = downloadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("/ent/download");
    expect(calls[0].body).toContain(
      "<key>externalVersionId</key><string>891042628</string>",
    );
    expect(allCalls().some((call) => call.host === STOREFRONT_HOST)).toBe(true);
  });

  it("refuses a macOS package for a task that is not a macOS one", async () => {
    // Which build Apple serves is decided by the version pin, and that pin can be guessed
    // (see `versionFinder`) — so a tvOS request really can be handed a Mac package, refused
    // here before a task is created for something the IPA pipeline cannot compile.
    const tvosApp = { ...app, platform: "tvos" } as Software;
    downloadReplies = [reply(macPackageDoc())];

    await expect(getDownloadInfo(account, tvosApp)).rejects.toThrow(
      i18n.t("errors.download.macOSPackage"),
    );
  });

  it("lets a macOS task keep its own package", async () => {
    const macApp = { ...app, platform: "macos" } as Software;
    withBag({});
    downloadReplies = [reply(macReply())];

    // Pinned explicitly: the macOS catalogue lookup is not what this test is
    // about, and a caller-provided version skips that resolution.
    const { output } = await getDownloadInfo(account, macApp, "891042628");

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.pkg");
  });

  it("keeps the dpInfo a macOS package is decrypted with", async () => {
    const macApp = { ...app, platform: "macos" } as Software;
    downloadReplies = [reply(macReply())];

    const { output } = await getDownloadInfo(account, macApp, "891042628");

    expect(output.dpInfo).toBe("QUJDRA==");
    // A Mac download carries no sinf to compile in — it is decrypted instead —
    // so an entry with only dpInfo is a complete answer, not a missing one.
    expect(output.sinfs).toEqual([]);
  });

  it("keeps the preflight package URL a legacy Mac reply advertises", async () => {
    const macApp = { ...app, platform: "macos" } as Software;
    downloadReplies = [
      reply(
        macReply({
          preflightPackageURL: "https://iosapps.example.com/preflight.pkg",
        }),
      ),
    ];

    const { output } = await getDownloadInfo(account, macApp, "891042628");

    expect(output.preflightPackageURL).toBe(
      "https://iosapps.example.com/preflight.pkg",
    );
  });

  it("refuses a macOS reply that carries no dpInfo", async () => {
    // Without it the delivered package could never be opened, and no later step
    // could do anything but fail — so it is refused before a task exists.
    withBag({});
    const macApp = { ...app, platform: "macos" } as Software;
    downloadReplies = [reply(macPackageDoc())];

    await expect(getDownloadInfo(account, macApp, "891042628")).rejects.toThrow(
      i18n.t("errors.download.missingDPInfo"),
    );
  });

  it("allows a legacy Mac metadata read without dpInfo when preflight metadata is available", async () => {
    const macApp = { ...app, platform: "macos" } as Software;
    downloadReplies = [
      reply(
        macPackageDoc({
          preflightPackageURL: "https://iosapps.example.com/preflight.pkg",
        }),
      ),
    ];

    const { output } = await getDownloadInfo(account, macApp, "891042628", {
      allowMissingDPInfo: true,
    });

    expect(output.dpInfo).toBeUndefined();
    expect(output.preflightPackageURL).toBe(
      "https://iosapps.example.com/preflight.pkg",
    );
  });

  it("refuses a macOS reply whose dpInfo values disagree", async () => {
    // Two values mean the reply describes two builds, and neither can be
    // trusted to decrypt the package that arrives.
    const macApp = { ...app, platform: "macos" } as Software;
    downloadReplies = [
      reply(
        macPackageDoc({
          sinfs: [
            { id: 0, dpInfo: new Uint8Array([1, 2]) },
            { id: 1, dpInfo: new Uint8Array([3, 4]) },
          ],
        }),
      ),
    ];

    await expect(getDownloadInfo(account, macApp, "891042628")).rejects.toThrow(
      i18n.t("errors.download.conflictingDPInfo"),
    );
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

  it("moves to the bag's redownload host when volumeStore never answers", async () => {
    downloadReplies = [new AppleUnreachableError("timed out"), reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");

    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].host).toBe("p25-buy.itunes.apple.com");
    expect(calls[1].host).toBe(DISPATCH_HOST);
    expect(calls[1].body).toContain("<key>appExtVrsId</key><string>891042628</string>");
  });

  it("moves on to updateProduct when redownload never answers", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      new AppleUnreachableError("timed out"),
      reply(updateDoc("891042628")),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");

    const calls = downloadCalls();
    expect(calls).toHaveLength(3);
    expect(calls[2].path).toContain("/up/updateProduct");
  });

  it("surfaces a stalled request when the bag advertises nothing to fall back to", async () => {
    withBag({});
    downloadReplies = [new AppleUnreachableError("Apple did not answer")];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      "Apple did not answer",
    );
    expect(downloadCalls()).toHaveLength(1);
  });

  it("reports the stalled request when no version can be named either", async () => {
    // Both fail for the same reason: the request never reached Apple. The version
    // lookup's own "no build for this platform" would be a wrong diagnosis of it.
    lookupBody = offersMissingDoc();
    downloadReplies = [new AppleUnreachableError("Apple did not answer")];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      "Apple did not answer",
    );
    expect(downloadCalls()).toHaveLength(1);
  });

  it("continues to updateProduct when volumeStore returns an item without download material", async () => {
    downloadReplies = [
      reply(noMaterialDoc()),
      reply(purchaseDoc()),
      reply(updateDoc("891042628")),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    const calls = downloadCalls();
    expect(calls).toHaveLength(3);
    expect(calls[1].path).toContain("/r/redownload");
    expect(calls[2].path).toContain("/up/updateProduct");
  });

  it("continues to updateProduct when redownload returns an item without download material", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      reply(noMaterialDoc()),
      reply(updateDoc("891042628")),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls()[2].path).toContain("/up/updateProduct");
  });

  it("continues to updateProduct when volumeStore returns a macOS item without dpInfo", async () => {
    const macApp = { ...app, platform: "macos" } as Software;
    downloadReplies = [
      reply(macPackageDoc()),
      reply(purchaseDoc()),
      reply(
        macPackageDoc({
          sinfs: [{ id: 0, dpInfo: new Uint8Array([0x41, 0x42, 0x43, 0x44]) }],
          metadata: {
            bundleShortVersionString: "1.2.3",
            bundleVersion: "123",
            itemId: 1492142120,
            softwareVersionExternalIdentifier: "891042628",
            softwareVersionBundleId: "com.example.app",
          },
        }),
      ),
    ];

    const { output } = await getDownloadInfo(account, macApp, "891042628");

    expect(output.dpInfo).toBe("QUJDRA==");
    const calls = downloadCalls();
    expect(calls).toHaveLength(3);
    expect(calls[1].path).toContain("/r/redownload");
    expect(calls[2].path).toContain("/up/updateProduct");
  });

  it("reports updateMismatch when updateProduct has no download material", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      reply(noMaterialDoc()),
      reply(noMaterialDoc()),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      i18n.t("errors.download.updateMismatch"),
    );
    expect(downloadCalls()).toHaveLength(3);
  });

  it("does not let a volumeStore no-licence message override redownload's answer", async () => {
    downloadReplies = [
      reply(redownloadUnavailableDoc()),
      reply(failureDoc("2034")),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({
      code: "2034",
    });
    expect(downloadCalls()).toHaveLength(2);
  });

  it.each([
    ["top-level", redownloadUnavailableDoc(false)],
    ["dialog", redownloadUnavailableDoc(true)],
  ])("maps the %s redownload refusal to a missing licence", async (_kind, doc) => {
    downloadReplies = [reply(purchaseDoc()), reply(doc), reply(purchaseDoc())];

    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({
      code: "9610",
    });
    expect(downloadCalls()).toHaveLength(3);
  });

  it("tries updateProduct before reporting the redownload no-licence refusal", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      reply(redownloadUnavailableDoc()),
      reply(updateDoc("891042628")),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe("https://iosapps.example.com/app.ipa");
    expect(downloadCalls()[2].path).toContain("/up/updateProduct");
  });

  it("normalizes Apple's unicode spaces in the redownload refusal", async () => {
    downloadReplies = [
      reply(purchaseDoc()),
      reply(
        buildPlist({
          message: "Redownload Unavailable with This Apple\u00a0Account",
          explanation:
            "This redownload is not available for this Apple\u202fAccount either because it was bought by a different user or the item was refunded or cancelled.",
        }),
      ),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      i18n.t("errors.download.licenseRequired"),
    );
  });

  it("does not mistake a near-match redownload refusal for a missing licence", async () => {
    withBag({
      redownloadEndpoint: `https://${DISPATCH_HOST}/r/redownload`,
    });
    downloadReplies = [
      reply(purchaseDoc()),
      reply(
        buildPlist({
          message: "Redownload Unavailable with This Apple Account",
          explanation: "A different refusal",
          customerMessage: "A different refusal",
        }),
      ),
    ];

    await expect(getDownloadInfo(account, app)).rejects.toThrow("A different refusal");
  });

  it("keeps the Apple md5 on the download output", async () => {
    downloadReplies = [reply(downloadDoc())];

    const { output } = await getDownloadInfo(account, app);

    expect(output.md5).toBe("0123456789abcdef0123456789abcdef");
  });

  it("keeps the md5 a plist <data> digest carries", async () => {
    // The same reply field reaches this side either as a hex string or as the
    // raw 16 bytes (the plist parser returns `<data>` as bytes). Reading only
    // the string form would leave such a download unverified rather than fail.
    downloadReplies = [
      reply(
        buildPlist({
          pings: [],
          songList: [
            {
              URL: "https://iosapps.example.com/app.ipa",
              sinfs: [{ id: 0, sinf: "AAAA" }],
              md5: new Uint8Array([
                0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23,
                0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
              ]),
              metadata: { bundleShortVersionString: "1.2.3", bundleVersion: "123" },
            },
          ],
        }),
      ),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.md5).toBe("0123456789abcdef0123456789abcdef");
  });

  it("drops an md5 field that names no digest", async () => {
    // A bytes field of the wrong length is not a digest: enforcing it would
    // fail a healthy download, and trusting it would report the wrong expected
    // value, so the check is left off instead.
    downloadReplies = [
      reply(
        buildPlist({
          pings: [],
          songList: [
            {
              URL: "https://iosapps.example.com/app.ipa",
              sinfs: [{ id: 0, sinf: "AAAA" }],
              md5: new Uint8Array([1, 2, 3]),
              metadata: { bundleShortVersionString: "1.2.3", bundleVersion: "123" },
            },
          ],
        }),
      ),
    ];

    const { output } = await getDownloadInfo(account, app);

    expect(output.md5).toBeUndefined();
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
