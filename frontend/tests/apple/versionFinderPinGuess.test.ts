import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appPresenceFromProbeError,
  PlatformVersionUnavailableError,
} from "../../src/apple/errors";
import { listVersions } from "../../src/apple/versionFinder";
import { requestDownloadProduct } from "../../src/apple/downloadProduct";
import { latestVersionIdForPlatform } from "../../src/apple/platformVersion";
import { apiGet } from "../../src/api/client";
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
  latestVersionIdForPlatform: vi.fn(),
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

// Every reply carries the artifact URL it would serve: a probe is accepted only
// when that artifact can be the platform's build (`artifactMatchesPlatform`).
const replyWithVersions = (
  identifiers: string[],
  url = "https://iosapps.example.com/app.ipa",
) => ({
  status: 200,
  data: {
    songList: [
      { URL: url, metadata: { softwareVersionExternalIdentifiers: identifiers } },
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
    // Both the recorded-pin store and the exchange: an implementation one test
    // installs must not reach the next one.
    vi.mocked(requestDownloadProduct).mockReset();
    vi.mocked(apiGet).mockReset();
    vi.mocked(latestVersionIdForPlatform).mockReset();
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
      // The tvOS history is its own id sequence, distinct from the iOS list —
      // the fingerprint check would refuse a hit whose history is the iOS one.
      if (pin === "8") return replyWithVersions(["20", "21", "22"]);
      throw new Error("not served");
    });

    const result = await listVersions(account, bareTvosApp);

    expect(result.versions).toEqual(["22", "21", "20"]);
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
        return replyWithVersions(["40", "41"]);
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
    expect(result.versions).toEqual(["41", "40"]);
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
        return replyWithVersions(["50", "51"]);
      }
      throw new Error("not served");
    });

    const result = await listVersions(account, localApp);

    expect(result.versions).toEqual(["51", "50"]);
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

  it("never offers another platform's build as this platform's pin", async () => {
    // A macOS page for an app that has no Mac version. The id one step from
    // the newest iOS build is this app's tvOS build: the exchange serves it
    // (an id names its own platform, whatever device class asks) — so the only
    // thing that can rule it out is knowing it was recorded as tvOS.
    const macApp = { ...bareTvosApp, platform: "macos" } as Software;
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "tvos", versionId: "13" }],
    } as never);
    const probed: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      if (!pin) return replyWithVersions(["10", "11", "12"]); // the iOS list
      probed.push(pin);
      // Anything but the tvOS build is not a build of this app at all.
      if (pin === "13") return replyWithVersions(["10", "11", "12"]);
      throw new Error("not served");
    });

    const error = await listVersions(account, macApp).catch((e: unknown) => e);

    // Nothing left to pin: the platform has no build, and that is the answer.
    expect(error).toBeInstanceOf(PlatformVersionUnavailableError);
    expect((error as Error).message).toBe(
      i18n.t("errors.download.missingVersion"),
    );
    expect(probed).not.toContain("13");
    // The app itself is not disowned by this — only the platform is.
    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
  });

  it("rules out an older build of another platform the index holds", async () => {
    // The Forward case, exactly: the iOS pin is 888154622 and the tvOS 1.3.18
    // build compiled here is 888154623 — one step away, and *not* the newest
    // tvOS id, so the pin store alone would not rule it out. The guess would
    // reach it first and hand a macOS page the tvOS build.
    const macApp = { ...bareTvosApp, platform: "macos" } as Software;
    vi.mocked(apiGet).mockImplementation(async (path: string) =>
      (path.includes("package-builds")
        ? {
            builds: [
              { platform: "ios", versionId: "12" },
              { platform: "tvos", versionId: "13" },
            ],
          }
        : { pins: [{ platform: "tvos", versionId: "19" }] }) as never,
    );
    vi.mocked(latestVersionIdForPlatform).mockResolvedValue(undefined);
    const probed: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      if (!pin) return replyWithVersions(["10", "11", "12"]);
      probed.push(pin);
      // 13 is a real build of this app — Apple serves it for any device class.
      if (pin === "13" || pin === "19") return replyWithVersions(["10", "11", "12"]);
      throw new Error("not served");
    });

    const error = await listVersions(account, macApp).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlatformVersionUnavailableError);
    expect(probed).not.toContain("13");
    expect(probed).not.toContain("19");
  });

  it("still accepts the macOS build a delisted Mac storefront no longer names", async () => {
    // The guess exists for exactly this: a delisted Mac app whose storefront
    // page is gone. Its Mac build serves a `.pkg` — the one artifact a macOS
    // page can use — so the guess must keep accepting it.
    const macApp = { ...bareTvosApp, platform: "macos" } as Software;
    vi.mocked(apiGet).mockResolvedValue({ pins: [] } as never);
    vi.mocked(latestVersionIdForPlatform).mockResolvedValue(undefined);
    const probed: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      if (!pin) return replyWithVersions(["10", "11", "12"]);
      probed.push(pin);
      // 14 is the Mac build: the artifact it serves is a macOS package, and
      // its history is the Mac id sequence — no iOS or tvOS id in it.
      if (pin === "14") {
        return replyWithVersions(
          ["40", "41", "42"],
          "https://iosapps.example.com/app.pkg",
        );
      }
      throw new Error("not served");
    });

    const result = await listVersions(account, macApp);

    expect(result.versions).toEqual(["42", "41", "40"]);
  });

  it("refuses a hit whose history names a build of another platform", async () => {
    // The artifact check alone is not enough for IPA-family platforms: a
    // macOS ask can be served an iOS/tvOS build (.ipa) just as willingly. The
    // served history is the fingerprint — if it names an id already known
    // under another platform, the pin landed there and is refused. This is
    // what finally settles Forward-as-macOS: no candidate survives.
    const macApp = { ...bareTvosApp, platform: "macos" } as Software;
    vi.mocked(apiGet).mockImplementation(async (path: string) =>
      path.includes("package-builds")
        ? { builds: [{ platform: "tvos", versionId: "19" }] }
        : { pins: [] },
    );
    vi.mocked(latestVersionIdForPlatform).mockResolvedValue(undefined);
    const probed: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      if (!pin) return replyWithVersions(["10", "11", "12"]);
      probed.push(pin);
      // Whatever this candidate is, its history carries the tvOS build this
      // instance already knows — the pin belongs to tvOS, not macOS.
      if (pin === "13")
        return replyWithVersions(
          ["19", "20"],
          "https://iosapps.example.com/app.ipa",
        );
      throw new Error("not served");
    });

    const error = await listVersions(account, macApp).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlatformVersionUnavailableError);
    expect(probed).not.toContain("19");
  });

  it("rules out the id another platform's own source names", async () => {
    // The build one id away is on offer for tvOS right now — this instance has
    // never downloaded it, so no recorded pin can rule it out; the tvOS
    // catalogue can.
    const macApp = { ...bareTvosApp, platform: "macos" } as Software;
    vi.mocked(apiGet).mockResolvedValue({ pins: [] } as never);
    vi.mocked(latestVersionIdForPlatform).mockImplementation(
      async (_id, _country, platform) =>
        platform === "tvos" ? "13" : undefined,
    );
    const probed: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      if (!pin) return replyWithVersions(["10", "11", "12"]);
      probed.push(pin);
      if (pin === "13") return replyWithVersions(["10", "11", "12"]);
      throw new Error("not served");
    });

    const error = await listVersions(account, macApp).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlatformVersionUnavailableError);
    expect(probed).not.toContain("13");
    // Every platform but the one being guessed for was asked.
    expect(
      vi
        .mocked(latestVersionIdForPlatform)
        .mock.calls.map((call) => call[2])
        .sort(),
    ).toEqual(["tvos", "visionos"]);
  });

  it("does not call a failed iOS list 'no version for this platform'", async () => {
    // The iOS list is what every guess offsets from. Not being able to read it
    // — a dead session, a blocked host — must stay an open question rather than
    // reading as "this platform has no build".
    const calls: string[] = [];
    vi.mocked(requestDownloadProduct).mockImplementation(async (_session, pin) => {
      calls.push(pin);
      throw new Error("cannot list");
    });

    const error = await listVersions(account, bareTvosApp).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toBe("cannot list");
    expect(appPresenceFromProbeError(error)).toBe("inconclusive");
    expect(calls).toEqual([""]);
  });
});
