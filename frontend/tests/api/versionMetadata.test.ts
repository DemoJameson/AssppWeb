import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchVersionMetadata,
  saveVersionMetadata,
} from "../../src/api/versionMetadata";

describe("fetchVersionMetadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the entries array into a version-id keyed record", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entries: [
            {
              versionId: "894041913",
              displayVersion: "8.2.1",
              releaseDate: "2025-06-12T00:00:00.000Z",
            },
          ],
        }),
    } as Response);

    const result = await fetchVersionMetadata(6503940939);
    expect(result).toEqual({
      "894041913": {
        displayVersion: "8.2.1",
        releaseDate: "2025-06-12T00:00:00.000Z",
      },
    });
    expect(fetch).toHaveBeenCalledWith("/api/version-metadata/6503940939", {
      headers: {},
    });
  });

  it("skips malformed entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ entries: [{ versionId: "1" }, null] }),
    } as Response);

    expect(await fetchVersionMetadata(1)).toEqual({});
  });

  it("resolves to an empty map when the backend call fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("Unauthorized"),
    } as Response);

    expect(await fetchVersionMetadata(1)).toEqual({});
  });
});

describe("saveVersionMetadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the entry with a keepalive request so page exits cannot drop it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ saved: true }),
    } as Response);

    await saveVersionMetadata(6503940939, "894041913", {
      displayVersion: "1.3.19",
      releaseDate: "2026-01-01T00:00:00.000Z",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/version-metadata/6503940939/894041913",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayVersion: "1.3.19",
          releaseDate: "2026-01-01T00:00:00.000Z",
        }),
        keepalive: true,
      },
    );
  });

  it("stays silent when the write fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("nope"),
    } as Response);

    await expect(
      saveVersionMetadata(1, "2", {
        displayVersion: "1.0.0",
        releaseDate: "d",
      }),
    ).resolves.toBeUndefined();
  });
});
