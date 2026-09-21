import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "../../src/api/client";
import {
  recordedVersionIdFor,
  recordedVersionIdsExceptPlatform,
  withRecordedFallback,
} from "../../src/apple/versionPins";

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn(),
}));

describe("apple/versionPins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the recorded id for the requested platform", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      pins: [
        { platform: "ios", versionId: "111" },
        { platform: "tvos", versionId: "222" },
      ],
    });

    expect(await recordedVersionIdFor(42, "tvos")).toBe("222");
    expect(apiGet).toHaveBeenCalledWith("/api/version-pins/42");
  });

  it("resolves undefined when the platform has no pin or the call fails", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "ios", versionId: "111" }],
    });
    expect(await recordedVersionIdFor(42, "macos")).toBeUndefined();

    vi.mocked(apiGet).mockRejectedValue(new Error("offline"));
    expect(await recordedVersionIdFor(42, "ios")).toBeUndefined();
  });

  it("prefers the live lookup over the recorded pin", async () => {
    const lookup = vi.fn().mockResolvedValue("900");
    expect(await withRecordedFallback(lookup, 42, "tvos")).toBe("900");
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("falls back to the recorded pin when the lookup yields nothing", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "tvos", versionId: "700" }],
    });
    const lookup = vi.fn().mockResolvedValue(undefined);
    expect(await withRecordedFallback(lookup, 42, "tvos")).toBe("700");
  });

  it("falls back to the recorded pin when the lookup throws", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "macos", versionId: "700" }],
    });
    const lookup = vi.fn().mockRejectedValue(new Error("no configuration"));
    expect(await withRecordedFallback(lookup, 42, "macos")).toBe("700");
  });

  it("stays quiet about a lookup failure when there is nothing recorded", async () => {
    // The raw lookup failure is not user-facing: callers turn “no pin” into
    // their own clean message, and the id stays usable either way.
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = vi.fn().mockRejectedValue(new Error("boom"));

    expect(await withRecordedFallback(lookup, 42, "macos")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resolves undefined when neither source materialises", async () => {
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });
    const lookup = vi.fn().mockResolvedValue(undefined);
    expect(await withRecordedFallback(lookup, 42, "tvos")).toBeUndefined();
  });

  it("hands back the ids recorded for the other platforms", async () => {
    // What a neighbour guess rules out: an id a download pinned under another
    // platform is that platform's build, the platform being guessed for never.
    vi.mocked(apiGet).mockResolvedValue({
      pins: [
        { platform: "ios", versionId: "111" },
        { platform: "tvos", versionId: "222" },
        { platform: "macos", versionId: "333" },
      ],
    });

    expect(await recordedVersionIdsExceptPlatform(42, "macos")).toEqual([
      "111",
      "222",
    ]);
  });

  it("keeps the other-platform ids best effort", async () => {
    // Nothing recorded, a broken store, and a pin with no id at all: the guess
    // simply has one less id it can rule out.
    vi.mocked(apiGet).mockResolvedValue({ pins: [] });
    expect(await recordedVersionIdsExceptPlatform(42, "macos")).toEqual([]);

    vi.mocked(apiGet).mockResolvedValue({
      pins: [{ platform: "tvos", versionId: "" }],
    });
    expect(await recordedVersionIdsExceptPlatform(42, "macos")).toEqual([]);

    vi.mocked(apiGet).mockRejectedValue(new Error("offline"));
    expect(await recordedVersionIdsExceptPlatform(42, "macos")).toEqual([]);
  });
});
