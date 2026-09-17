import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSearch } from "../../src/hooks/useSearch";
import { searchApps, lookupApp } from "../../src/api/search";
import type { Software } from "../../src/types";

vi.mock("../../src/api/search", () => ({
  searchApps: vi.fn(),
  lookupApp: vi.fn(),
}));

const mockedSearchApps = vi.mocked(searchApps);
const mockedLookupApp = vi.mocked(lookupApp);

function app(overrides: Partial<Software> = {}): Software {
  return {
    id: 6503940939,
    bundleID: "flux.inchmade.app",
    name: "Forward",
    version: "1.3.18",
    artistName: "",
    sellerName: "",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "",
    releaseDate: "",
    primaryGenreName: "",
    ...overrides,
  };
}

describe("useSearch.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearch.setState({
      term: "",
      country: "",
      platform: "ios",
      results: [],
      loading: false,
      error: null,
    });
  });

  it("routes a bundle id through the exact lookup instead of the text search", async () => {
    mockedLookupApp.mockResolvedValue(app());

    await useSearch.getState().search("flux.inchmade.app", "US", "ios");

    expect(mockedLookupApp).toHaveBeenCalledWith(
      "flux.inchmade.app",
      "US",
      "ios",
    );
    expect(mockedSearchApps).not.toHaveBeenCalled();
    expect(useSearch.getState().results).toEqual([app()]);
  });

  it("keeps the fuzzy search for plain text", async () => {
    mockedSearchApps.mockResolvedValue([app({ name: "Forward" })]);

    await useSearch.getState().search("forward", "US", "ios");

    expect(mockedSearchApps).toHaveBeenCalledWith("forward", "US", "ios");
    expect(mockedLookupApp).not.toHaveBeenCalled();
    expect(useSearch.getState().results).toHaveLength(1);
  });

  it("reports a bundle-id miss as an empty result set, not as noise", async () => {
    mockedLookupApp.mockResolvedValue(null);

    await useSearch.getState().search("com.example.missing", "US", "ios");

    expect(useSearch.getState().results).toEqual([]);
    expect(useSearch.getState().error).toBeNull();
  });
});
