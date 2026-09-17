import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVersionMetadataMap } from "../../src/hooks/useVersionMetadata";
import { fetchVersionMetadata } from "../../src/api/versionMetadata";

vi.mock("../../src/api/versionMetadata", () => ({
  fetchVersionMetadata: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchVersionMetadata);

describe("useVersionMetadataMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges cached entries fetched by ensureLoaded", async () => {
    mockedFetch.mockResolvedValue({
      "894041913": {
        displayVersion: "8.2.1",
        releaseDate: "2025-06-12T00:00:00.000Z",
      },
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    await act(() => result.current.ensureLoaded(6503940939));

    expect(result.current.versionMeta["894041913"].displayVersion).toBe("8.2.1");
  });

  it("keeps an existing entry when the cache brings a duplicate", async () => {
    mockedFetch.mockResolvedValue({
      "1": { displayVersion: "9.9.9", releaseDate: "cached" },
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.putEntry("1", {
        displayVersion: "1.0.0",
        releaseDate: "fetched",
      });
    });
    await act(() => result.current.ensureLoaded(1));

    expect(result.current.versionMeta["1"].displayVersion).toBe("1.0.0");
  });

  it("putEntry keeps the first write for a version", () => {
    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.putEntry("2", {
        displayVersion: "1.0.0",
        releaseDate: "a",
      });
      result.current.putEntry("2", {
        displayVersion: "2.0.0",
        releaseDate: "b",
      });
    });

    expect(result.current.versionMeta["2"].displayVersion).toBe("1.0.0");
  });

  it("leaves state untouched when the cache has nothing", async () => {
    mockedFetch.mockResolvedValue({});

    const { result } = renderHook(() => useVersionMetadataMap());
    await act(() => result.current.ensureLoaded(1));

    expect(result.current.versionMeta).toEqual({});
  });
});
