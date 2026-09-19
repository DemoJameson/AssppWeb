import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSearch } from "../../src/hooks/useSearch";
import { searchApps, lookupApp, lookupAppById } from "../../src/api/search";
import type { Software } from "../../src/types";

vi.mock("../../src/api/search", () => ({
  searchApps: vi.fn(),
  lookupApp: vi.fn(),
  lookupAppById: vi.fn(),
}));

const mockedSearchApps = vi.mocked(searchApps);
const mockedLookupApp = vi.mocked(lookupApp);
const mockedLookupAppById = vi.mocked(lookupAppById);

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
      searched: false,
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

  it("routes a store link through the App ID lookup", async () => {
    mockedLookupAppById.mockResolvedValue(app());

    await useSearch
      .getState()
      .search("https://apps.apple.com/cn/app/id6503940939", "US", "ios");

    expect(mockedLookupAppById).toHaveBeenCalledWith("6503940939", "US", "ios");
    expect(mockedSearchApps).not.toHaveBeenCalled();
    expect(useSearch.getState().results).toEqual([app()]);
  });

  it("keeps the newest search's results when an older one resolves late", async () => {
    let resolveFirst!: (apps: Software[]) => void;
    mockedSearchApps
      .mockImplementationOnce(
        () =>
          new Promise<Software[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce([app({ name: "Second" })]);

    const first = useSearch.getState().search("first", "US", "ios");
    const second = useSearch.getState().search("second", "US", "ios");
    await second;
    expect(useSearch.getState().results).toEqual([app({ name: "Second" })]);

    // The stale response lands later and must not overwrite the newest one.
    resolveFirst([app({ name: "First" })]);
    await first;
    expect(useSearch.getState().results).toEqual([app({ name: "Second" })]);
    expect(useSearch.getState().loading).toBe(false);
  });

  it("turns a missed App ID into a bare record for the direct-download path", async () => {
    // The id lookup may recall a delisted app from the backend's index; a miss
    // stays usable — the search page then probes it through the version
    // exchange, and only a "no such app" answer drops it again.
    mockedLookupAppById.mockResolvedValue(null);

    await useSearch.getState().search("6503940939", "US", "ios");

    expect(mockedLookupAppById).toHaveBeenCalledWith("6503940939", "US", "ios");
    expect(mockedSearchApps).not.toHaveBeenCalled();
    expect(useSearch.getState().results).toEqual([
      expect.objectContaining({
        id: 6503940939,
        name: "App 6503940939",
        platform: "ios",
        metadataSource: "bare",
      }),
    ]);
  });

  it("remembers that a search ran even when it found nothing", async () => {
    mockedLookupApp.mockResolvedValue(null);

    expect(useSearch.getState().searched).toBe(false);

    await useSearch.getState().search("com.example.missing", "US", "ios");

    expect(useSearch.getState().results).toEqual([]);
    expect(useSearch.getState().searched).toBe(true);

    useSearch.getState().clear();
    expect(useSearch.getState().searched).toBe(false);
  });

  it("drops a bare record the version exchange disproved, keeping the miss state", async () => {
    // The probe concluded the id is not an app: the record goes, and the page
    // still reports a real miss rather than "not searched yet".
    mockedLookupAppById.mockResolvedValue(null);

    await useSearch.getState().search("6503940939", "US", "ios");
    expect(useSearch.getState().results).toHaveLength(1);

    useSearch.getState().dropResult(6503940939);

    expect(useSearch.getState().results).toEqual([]);
    expect(useSearch.getState().searched).toBe(true);
  });

  it("leaves the other results in place when one is dropped", async () => {
    mockedSearchApps.mockResolvedValue([
      app({ id: 111 }),
      app({ id: 222 }),
    ]);

    await useSearch.getState().search("forward", "US", "ios");
    useSearch.getState().dropResult(222);

    expect(useSearch.getState().results.map((entry) => entry.id)).toEqual([111]);
  });
});
