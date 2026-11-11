import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  defaultAuthURL,
  fetchBag,
  normalizeAuthURL,
} from "../../src/apple/bag";

describe("apple/bag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses authenticateAccount from urlBag", async () => {
    const xml = buildPlist({
      urlBag: {
        authenticateAccount:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/",
    );
  });

  it("keeps a native auth endpoint at the plist root as the bag advertises it", async () => {
    const xml = buildPlist({
      authenticateAccount: "https://auth.itunes.apple.com/auth/v1/native",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(
      "https://auth.itunes.apple.com/auth/v1/native",
    );
  });

  it("falls back when authenticateAccount is missing", async () => {
    const xml = buildPlist({
      urlBag: {
        Ghostrider: "YES",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(defaultAuthURL);
  });

  it("falls back when bag proxy returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({ error: "upstream failed" }),
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(defaultAuthURL);
  });

  it("surfaces the download fallback hosts the bag advertises", async () => {
    const xml = buildPlist({
      urlBag: {
        authenticateAccount:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
        redownloadProduct: "https://downloaddispatch.itunes.apple.com/r/redownload",
        updateProduct: "https://downloaddispatch.itunes.apple.com/up/updateProduct",
        volumeStoreDownloadProduct:
          "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download",
        songDownloadDone:
          "https://buy.itunes.apple.com/WebObjects/MZFastFinance.woa/wa/songDownloadDone",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.redownloadEndpoint).toBe(
      "https://downloaddispatch.itunes.apple.com/r/redownload",
    );
    expect(result.updateEndpoint).toBe(
      "https://downloaddispatch.itunes.apple.com/up/updateProduct",
    );
    expect(result.entDownloadEndpoint).toBe(
      "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download",
    );
    expect(result.songDownloadDoneEndpoint).toBe(
      "https://buy.itunes.apple.com/WebObjects/MZFastFinance.woa/wa/songDownloadDone",
    );
  });

  it("extracts both machine provisioning families from the bag", async () => {
    const xml = buildPlist({
      authenticateAccount: "https://auth.itunes.apple.com/auth/v1/native",
      "amd-finish-provisioning":
        "https://auth.itunes.apple.com/auth/v1/otp/1.5/finish",
      "md-finish-provisioning":
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
      "amd-sync-machine":
        "https://auth.itunes.apple.com/auth/v1/otp/1.5/sync",
      "md-sync-machine":
        "https://auth.itunes.apple.com/auth/v1/otp/1.0/sync",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.amdFinishProvisioning).toBe(
      "https://auth.itunes.apple.com/auth/v1/otp/1.5/finish",
    );
    expect(result.mdFinishProvisioning).toBe(
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
    );
    expect(result.amdSyncMachine).toBe(
      "https://auth.itunes.apple.com/auth/v1/otp/1.5/sync",
    );
    expect(result.mdSyncMachine).toBe(
      "https://auth.itunes.apple.com/auth/v1/otp/1.0/sync",
    );
  });

  describe("normalizeAuthURL", () => {
    it("keeps a bare native auth endpoint as-is", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native");
    });

    it("keeps /fast without adding a trailing slash", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast");
    });

    it("is idempotent on an already-normalized endpoint", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast/"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it("adds the trailing slash to the legacy storefront endpoint", () => {
      expect(
        normalizeAuthURL(
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
        ),
      ).toBe(
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/",
      );
    });

    it("keeps a query string behind the trailing slash", () => {
      expect(
        normalizeAuthURL(
          "https://p30-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff",
        ),
      ).toBe(
        "https://p30-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/?guid=aabbccddeeff",
      );
    });

    it("is idempotent on an already-slashed legacy endpoint", () => {
      expect(
        normalizeAuthURL(
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/",
        ),
      ).toBe(
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/",
      );
    });

    it("leaves every other endpoint unchanged", () => {
      const other =
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct";
      expect(normalizeAuthURL(other)).toBe(other);
    });
  });
});
