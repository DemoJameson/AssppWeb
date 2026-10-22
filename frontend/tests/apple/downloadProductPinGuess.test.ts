import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  createDownloadSession,
  requestDownloadProduct,
} from "../../src/apple/downloadProduct";
import type { Account, Software } from "../../src/types";

// The exchange hits the network through `appleRequest`; faking it drives the whole
// `requestDownloadProduct` path — including the guess's probes — without libcurl.
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
}));

// The catalogue has no offer for a delisted app — the case the guess exists for.
vi.mock("../../src/apple/platformVersion", () => ({
  lookupLatestExternalVersionId: vi.fn().mockResolvedValue(undefined),
  lookupLatestMacOSVersionId: vi.fn().mockResolvedValue(undefined),
  latestVersionIdForPlatform: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/apple/sap/client", () => ({
  generateDownloadKBSync: vi.fn(),
}));

import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";

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

const bareTvosApp = {
  id: 6503940939,
  bundleID: "flux.inchmade.app",
  name: "App 6503940939",
  version: "",
  platform: "tvos",
  metadataSource: "bare",
} as Software;

const bareIOSApp = {
  ...bareTvosApp,
  id: 6801583759,
  bundleID: "tv.rexnow.app",
  platform: "ios",
} as Software;

// Every reply carries the artifact URL it would serve: a guess candidate is
// accepted only when that artifact can be the platform's build.
function plistResponse(
  identifiers: string[],
  url = "https://iosapps.example.com/app.ipa",
) {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    rawHeaders: [],
    body: buildPlist({
      songList: [
        { URL: url, metadata: { softwareVersionExternalIdentifiers: identifiers } },
      ],
    }),
  };
}

describe("downloadProduct direct-download pin guess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.example",
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("guesses a tvOS pin for a delisted app when no pin is supplied", async () => {
    const calls: Array<{ pinned: boolean }> = [];
    vi.mocked(appleRequest).mockImplementation(async (opts) => {
      // The volumeStore payload carries externalVersionId only when pinned: unpinned is
      // the iOS list fetch the guess starts from, pinned serves the tvOS history — a
      // distinct id sequence, which the fingerprint check requires of a candidate.
      const pinned = opts.body?.includes("externalVersionId") ?? false;
      calls.push({ pinned });
      return pinned
        ? plistResponse(["21", "22", "23"])
        : plistResponse(["10", "11", "12"]);
    });

    const session = createDownloadSession(account, bareTvosApp);
    const reply = await requestDownloadProduct(session, "");

    // The download succeeded — the guess named a pin the exchange served.
    expect(reply.data?.songList).toBeDefined();
    expect(reply.data?.songList).toHaveLength(1);

    // Eight exchanges: the iOS version list (unpinned), six neighbour probes (pinned),
    // and the download itself (pinned). The probes run concurrently via Promise.all, so
    // all six fire even though the first one already hits.
    expect(calls).toHaveLength(8);
    expect(calls[0]).toEqual({ pinned: false });
    expect(calls.slice(1, 7).every((c) => c.pinned)).toBe(true);
    expect(calls[7]).toEqual({ pinned: true });
  });

  it("does not guess when a pin is already supplied", async () => {
    const calls: Array<{ pinned: boolean }> = [];
    vi.mocked(appleRequest).mockImplementation(async (opts) => {
      const pinned = opts.body?.includes("externalVersionId") ?? false;
      calls.push({ pinned });
      return plistResponse(["10", "11", "12"]);
    });

    const session = createDownloadSession(account, bareTvosApp);
    const reply = await requestDownloadProduct(session, "42");

    expect(reply.data?.songList).toBeDefined();
    // Only the download itself — no iOS list, no probe.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pinned: true });
  });

  it("keeps pin-guess probes on the legacy endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.example",
      entDownloadEndpoint:
        "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download",
    });
    const calls: Array<{ pinned: boolean; path: string }> = [];
    vi.mocked(appleRequest).mockImplementation(async (opts) => {
      const pinned = opts.body?.includes("externalVersionId") ?? false;
      calls.push({ pinned, path: opts.path });
      return pinned
        ? plistResponse(["21", "22", "23"])
        : plistResponse(["10", "11", "12"]);
    });

    const session = createDownloadSession(account, { ...bareTvosApp, platform: "ios" });
    await requestDownloadProduct(session, "", { legacyOnly: true });

    // legacyOnly is the probe profile: it must not guess again (which would fan
    // out into more probes) and must stay off ent/download. The bare iOS record
    // has no catalogue pin, so the request reaches the legacy exchange without one.
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("/volumeStoreDownloadProduct");
    expect(calls[0].pinned).toBe(false);
  });

  it("does not recursively pre-pin a bare iOS request", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.example",
      entDownloadEndpoint:
        "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download",
    });
    const calls: Array<{ path: string }> = [];
    vi.mocked(appleRequest).mockImplementation(async (opts) => {
      calls.push({ path: opts.path });
      return plistResponse(["10", "11", "12"]);
    });

    const session = createDownloadSession(account, bareIOSApp);
    await requestDownloadProduct(session, "");

    // No catalogue offer leaves no ent pin. The request goes straight to the
    // legacy chain instead of recursively asking for another pin.
    expect(calls.some((call) => call.path.includes("/ent/download"))).toBe(false);
    expect(calls.some((call) => call.path.includes("/volumeStoreDownloadProduct"))).toBe(true);
  });
});
