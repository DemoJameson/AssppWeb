import { beforeEach, describe, expect, it } from "vitest";
import { useVersionMetadataStore } from "../../src/store/versionMetadata";
import type { VersionMetadata } from "../../src/types";

const entry: VersionMetadata = {
  displayVersion: "1.0.0",
  releaseDate: "2026-01-01T00:00:00Z",
  source: "package",
};

describe("versionMetadata store", () => {
  beforeEach(() => {
    useVersionMetadataStore.setState({
      entries: {},
      pending: {},
      attempted: {},
    });
  });

  it("adds the ids the store does not know yet", () => {
    useVersionMetadataStore.getState().mergeEntries({
      "1": entry,
      "2": { ...entry, displayVersion: "2.0.0" },
    });

    expect(useVersionMetadataStore.getState().entries).toEqual({
      "1": entry,
      "2": { ...entry, displayVersion: "2.0.0" },
    });
  });

  it("hands the same entries object back when a merge adds nothing", () => {
    // Cached-first: a merge only ever adds, so an existing id is a no-op — and
    // a no-op must not look like a change. The pages that fold the shared cache
    // in subscribe to `entries`; a fresh object would re-render them, and the
    // read that produced this merge would run again (the request loop).
    useVersionMetadataStore.getState().mergeEntries({ "1": entry });
    const merged = useVersionMetadataStore.getState().entries;

    useVersionMetadataStore.getState().mergeEntries({ "1": entry });

    expect(useVersionMetadataStore.getState().entries).toBe(merged);
  });

  it("keeps the entry already on screen while adding the new ones", () => {
    useVersionMetadataStore.getState().mergeEntries({
      "1": { ...entry, displayVersion: "1.0.0" },
    });

    useVersionMetadataStore.getState().mergeEntries({
      "1": { ...entry, displayVersion: "9.9.9" },
      "2": { ...entry, displayVersion: "2.0.0" },
    });

    const entries = useVersionMetadataStore.getState().entries;
    expect(entries["1"].displayVersion).toBe("1.0.0");
    expect(entries["2"].displayVersion).toBe("2.0.0");
  });

  describe("putEntry", () => {
    const put = (id: string, metadata: VersionMetadata) =>
      useVersionMetadataStore.getState().putEntry(id, metadata);

    it("lets a package read fill in a version the exchange could only number", () => {
      // The order the page works in: the fallback puts the exchange's value — a
      // number, plus a date that dates the app and so is never printed — and the
      // package read then brings the build's own date as `package-read`.
      put("1", {
        displayVersion: "1.0.0",
        releaseDate: "2026-01-01T00:00:00Z",
        source: "client",
      });
      put("1", {
        displayVersion: "1.0.0",
        releaseDate: "2026-06-06T00:00:00Z",
        source: "package-read",
      });

      const stored = useVersionMetadataStore.getState().entries["1"];
      expect(stored.source).toBe("package-read");
      expect(stored.releaseDate).toBe("2026-06-06T00:00:00Z");
    });

    it("does not let the exchange's app-level date displace a build's", () => {
      put("1", { ...entry, source: "package-read" });
      put("1", {
        displayVersion: "1.0.0",
        releaseDate: "2020-01-01T00:00:00Z",
        source: "client",
      });

      expect(
        useVersionMetadataStore.getState().entries["1"].releaseDate,
      ).toBe("2026-01-01T00:00:00Z");
    });

    it("keeps the first write when the second is not a package read", () => {
      put("1", entry);
      put("1", { ...entry, displayVersion: "9.9.9", source: "client" });

      expect(useVersionMetadataStore.getState().entries["1"].displayVersion).toBe(
        "1.0.0",
      );
    });
  });
});
