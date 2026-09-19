import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appPresenceFromProbeError } from "../../src/apple/errors";
import { listVersions } from "../../src/apple/versionFinder";
import { requestDownloadProduct } from "../../src/apple/downloadProduct";
import i18n from "../../src/i18n";
import type { Account, Software } from "../../src/types";

// Keep the real accessors and session factory; only the exchange itself is
// faked — that is the layer the pin guess drives.
vi.mock("../../src/apple/downloadProduct", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/apple/downloadProduct")>();
  return { ...actual, requestDownloadProduct: vi.fn() };
});

// Pull the heavy transport (and its wasm chain) out of this file's graph;
// nothing here reaches the network.
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn(),
}));

// The catalogue lookup is not what this file exercises: it never names a pin.
vi.mock("../../src/apple/platformVersion", () => ({
  lookupLatestExternalVersionId: vi.fn(),
  lookupLatestMacOSVersionId: vi.fn(),
}));

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

const replyWithVersions = (identifiers: string[]) => ({
  status: 200,
  data: {
    songList: [
      { metadata: { softwareVersionExternalIdentifiers: identifiers } },
    ],
  },
  body: "",
  headers: {},
  rawHeaders: [],
  endpoint: "test",
});

describe("apple/versionFinder pin guess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestDownloadProduct).mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never probes an id the iOS version list carries", async () => {
    const iosIds = ["9", "10", "11", "12"];
    const calls: Array<{ platform?: string; pin: string }> = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (session, pin) => {
      calls.push({ platform: session.app.platform, pin });
      if (!pin) return replyWithVersions(iosIds); // iOS, oldest → newest
      if (pin === "8") return replyWithVersions(["10", "11", "12"]);
      throw new Error("not served");
    });

    const result = await listVersions(account, bareTvosApp);

    expect(result.versions).toEqual(["12", "11", "10"]);
    // The iOS exchange named the anchor; the probes ran on tvOS over its
    // neighbours, nearest first — and the ids the list itself carries (11, 10,
    // 9, and the anchor 12) were skipped rather than probed.
    expect(calls[0]).toEqual({ platform: "ios", pin: "" });
    expect(calls.slice(1, 7).map((call) => call.pin)).toEqual([
      "13",
      "14",
      "15",
      "16",
      "8",
      "17",
    ]);
    const probed = calls.slice(1).map((call) => call.pin);
    expect(probed.filter((pin) => iosIds.includes(pin))).toEqual([]);
    // The list exchange runs on the neighbour that was served.
    expect(calls[7]).toEqual({ platform: "tvos", pin: "8" });
    expect(
      calls.every((call, index) => index === 0 || call.platform === "tvos"),
    ).toBe(true);
  });

  it("keeps walking outward in batches until a neighbour answers", async () => {
    let active = 0;
    let maxActive = 0;
    const pins: string[] = [];
    // Only the anchor itself is off limits, so both directions are eligible and
    // the walk needs two batches — the hit sits in the second one.
    const iosIds = ["12"];
    vi.mocked(requestDownloadProduct).mockImplementation(async (session, pin) => {
      if (!pin) return replyWithVersions(iosIds);
      pins.push(pin);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (pin === "18" && session.app.platform === "tvos") {
        return replyWithVersions(["10", "11", "12"]);
      }
      throw new Error("not served");
    });

    const result = await listVersions(account, bareTvosApp);

    // Anchor 12: ±1 … ±6 nearest first, six probes to a batch, then the list
    // exchange pinned to the neighbour that answered.
    expect(pins).toEqual([
      "13",
      "11",
      "14",
      "10",
      "15",
      "9",
      "16",
      "8",
      "17",
      "7",
      "18",
      "6",
      "18",
    ]);
    expect(result.versions).toEqual(["12", "11", "10"]);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it("probes nothing when the iOS list already covers every neighbour", async () => {
    const calls: string[] = [];
    // A list whose newest id (our anchor) sits in the middle: 12 first, then
    // 2…11 and 13…22 — every id within six steps is an iOS build, so there is
    // no candidate left to probe.
    const covered = [
      ...Array.from({ length: 10 }, (_, index) => String(22 - index)),
      ...Array.from({ length: 10 }, (_, index) => String(11 - index)),
      "12",
    ];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      calls.push(pin);
      if (!pin) return replyWithVersions(covered);
      throw new Error("not served");
    });

    const error = await listVersions(account, bareTvosApp).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toBe(
      i18n.t("errors.download.missingVersion"),
    );
    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
    expect(calls).toEqual([""]);
  });

  it("guesses for a package-index record, whose evidence covers another platform", async () => {
    // An iOS build downloaded here, asked for as tvOS: the app is real, but no
    // catalogue offer and no recorded pin names a tvOS build, so the guess is
    // the only way to name one.
    const localApp = { ...bareTvosApp, metadataSource: "local" } as Software;
    const calls: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (session, pin) => {
      calls.push(pin);
      if (!pin) return replyWithVersions(["10", "11", "12"]); // iOS list
      if (pin === "13" && session.app.platform === "tvos") {
        return replyWithVersions(["10", "11", "12"]);
      }
      throw new Error("not served");
    });

    const result = await listVersions(account, localApp);

    expect(result.versions).toEqual(["12", "11", "10"]);
    expect(calls[0]).toBe("");
    // …and the list exchange runs on the neighbour that was served.
    expect(calls[calls.length - 1]).toBe("13");
    expect(calls).not.toContain("12");
  });

  it("does not guess for a storefront record", async () => {
    // The storefront already enumerated what it offers for this platform, so a
    // missing offer is its answer rather than something to guess around — what
    // the guess exists for is records that never had storefront data.
    const storeApp = { ...bareTvosApp, metadataSource: undefined } as Software;

    const error = await listVersions(account, storeApp).catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      i18n.t("errors.download.missingVersion"),
    );
    expect(vi.mocked(requestDownloadProduct)).not.toHaveBeenCalled();
  });

  it("skips the guess when the iOS list itself cannot be read", async () => {
    const calls: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      calls.push(pin);
      throw new Error("cannot list");
    });

    const error = await listVersions(account, bareTvosApp).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toBe(
      i18n.t("errors.download.missingVersion"),
    );
    expect(calls).toEqual([""]);
  });
});
