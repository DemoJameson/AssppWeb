import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "../../src/api/client";
import { fetchPackageBuilds } from "../../src/api/packageBuilds";

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn(),
}));

describe("api/packageBuilds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns every build the index holds, with its platform", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      builds: [
        { platform: "ios", versionId: "888154622", version: "1.3.18" },
        { platform: "tvos", versionId: "888154623", version: "1.3.18" },
      ],
    });

    expect(await fetchPackageBuilds(6503940939)).toEqual([
      { platform: "ios", versionId: "888154622", version: "1.3.18" },
      { platform: "tvos", versionId: "888154623", version: "1.3.18" },
    ]);
    expect(apiGet).toHaveBeenCalledWith("/api/package-builds/6503940939");
  });

  it("resolves to an empty list when the store has nothing or fails", async () => {
    // An app the index has never seen, and a backend that is not answering:
    // both leave the caller with one less id it can rule out, never an error.
    vi.mocked(apiGet).mockResolvedValue({ builds: [] });
    expect(await fetchPackageBuilds(1)).toEqual([]);

    vi.mocked(apiGet).mockResolvedValue({});
    expect(await fetchPackageBuilds(2)).toEqual([]);

    vi.mocked(apiGet).mockRejectedValue(new Error("offline"));
    expect(await fetchPackageBuilds(3)).toEqual([]);
  });
});
