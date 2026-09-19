import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  createDownloadSession,
  requestDownloadProduct,
} from "../../src/apple/downloadProduct";
import type { Account, Software } from "../../src/types";

// The exchange hits the network through `appleRequest`; faking it here drives
// the whole `requestDownloadProduct` path — including the guess's probes —
// without touching libcurl.
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
}));

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn().mockResolvedValue(undefined),
}));

import { appleRequest } from "../../src/apple/request";

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

function plistResponse(identifiers: string[]) {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    rawHeaders: [],
    body: buildPlist({
      songList: [
        { metadata: { softwareVersionExternalIdentifiers: identifiers } },
      ],
    }),
  };
}

describe("downloadProduct direct-download pin guess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("guesses a tvOS pin for a delisted app when no pin is supplied", async () => {
    const calls: Array<{ pinned: boolean }> = [];
    vi.mocked(appleRequest).mockImplementation(async (opts) => {
      // The volumeStore payload carries externalVersionId only when a pin is
      // set; an unpinned request is the iOS list fetch the guess starts from.
      const pinned = opts.body?.includes("externalVersionId") ?? false;
      calls.push({ pinned });
      return plistResponse(["10", "11", "12"]);
    });

    const session = createDownloadSession(account, bareTvosApp);
    const reply = await requestDownloadProduct(session, "");

    // The download succeeded — the guess named a pin the exchange served.
    expect(reply.data?.songList).toBeDefined();
    expect(reply.data?.songList).toHaveLength(1);

    // Eight exchanges: the iOS version list (unpinned), six neighbour probes
    // in the first batch (pinned), and the download itself (pinned). The
    // probes run concurrently via Promise.all, so all six fire even though
    // the first one already hits.
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
});