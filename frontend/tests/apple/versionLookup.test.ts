import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { getVersionMetadata } from "../../src/apple/versionLookup";
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
const VERSION_ID = "818970197";

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

const metadataDoc = (metadata: Record<string, unknown>) =>
  buildPlist({
    pings: [],
    songList: [
      {
        URL: "https://iosapps.example.com/app.ipa",
        sinfs: [{ id: 0, sinf: "AAAA" }],
        metadata,
      },
    ],
  });

const emptyDoc = () =>
  buildPlist({ pings: [], jingleDocType: "purchaseSuccess", jingleAction: "purchaseProduct", status: 0 });

const failureDoc = (failureType: string, customerMessage?: string) =>
  buildPlist({ failureType, ...(customerMessage ? { customerMessage } : {}) });

type RequestOptions = { host: string; path: string; body?: string };

let downloadReplies: Reply[] = [];

const allCalls = () => vi.mocked(appleRequest).mock.calls.map((call) => call[0] as RequestOptions);
const downloadCalls = () => allCalls().filter((options) => options.host !== LOOKUP_HOST);

describe("apple/versionLookup", () => {
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
        return reply("{}");
      }
      const next = downloadReplies.shift();
      if (!next) {
        throw new Error("unexpected extra download request");
      }
      return next;
    });
  });

  it("pins the requested version on the primary endpoint", async () => {
    downloadReplies = [
      reply(
        metadataDoc({
          bundleShortVersionString: "4.5.6",
          releaseDate: "2024-03-01T08:00:00Z",
        }),
      ),
    ];

    const result = await getVersionMetadata(account, app, VERSION_ID);

    expect(result.metadata.displayVersion).toBe("4.5.6");
    expect(result.metadata.releaseDate).toBe("2024-03-01T08:00:00Z");

    const calls = downloadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe("p25-buy.itunes.apple.com");
    expect(calls[0].body).toContain(
      `<key>externalVersionId</key><string>${VERSION_ID}</string>`,
    );
    // An explicitly pinned request must not consult the catalogue.
    expect(allCalls().filter((c) => c.host === LOOKUP_HOST)).toHaveLength(0);
  });

  it("normalises a plist date value to ISO", async () => {
    downloadReplies = [
      reply(
        metadataDoc({
          bundleShortVersionString: "1.0",
          releaseDate: new Date("2023-12-25T00:00:00Z"),
        }),
      ),
    ];

    const result = await getVersionMetadata(account, app, VERSION_ID);

    expect(result.metadata.releaseDate).toBe("2023-12-25T00:00:00.000Z");
  });

  it("reaches the fallback host carrying the requested version", async () => {
    downloadReplies = [
      reply(emptyDoc()),
      reply(
        metadataDoc({
          bundleShortVersionString: "4.5.6",
          releaseDate: "2024-03-01T08:00:00Z",
        }),
      ),
    ];

    const result = await getVersionMetadata(account, app, VERSION_ID);

    expect(result.metadata.displayVersion).toBe("4.5.6");

    const calls = downloadCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].host).toBe(DISPATCH_HOST);
    expect(calls[1].path).toContain("/r/redownload");
    // The pinned version travels to the dispatch hop under its own key.
    expect(calls[1].body).toContain(`<key>appExtVrsId</key><string>${VERSION_ID}</string>`);
    // Already pinned, so no catalogue lookup is needed.
    expect(allCalls().filter((c) => c.host === LOOKUP_HOST)).toHaveLength(0);
  });

  it.each([["2034"], ["2042"]])("reports %s as an expired session", async (failureType) => {
    downloadReplies = [reply(failureDoc(failureType))];

    await expect(getVersionMetadata(account, app, VERSION_ID)).rejects.toThrow(
      i18n.t("errors.versions.passwordExpired"),
    );
  });

  it("reports 9610 as a missing license", async () => {
    downloadReplies = [reply(failureDoc("9610"))];

    await expect(getVersionMetadata(account, app, VERSION_ID)).rejects.toThrow(
      i18n.t("errors.versions.licenseRequired"),
    );
  });

  it("prefers Apple's own message when it accompanies no items", async () => {
    downloadReplies = [reply(failureDoc("startupFailure", "This app is not available"))];

    await expect(getVersionMetadata(account, app, VERSION_ID)).rejects.toThrow(
      /This app is not available/,
    );
  });

  it("fails when the reply describes no version", async () => {
    downloadReplies = [reply(metadataDoc({}))];

    await expect(getVersionMetadata(account, app, VERSION_ID)).rejects.toThrow(
      i18n.t("errors.versions.missingMetadata"),
    );
  });
});
