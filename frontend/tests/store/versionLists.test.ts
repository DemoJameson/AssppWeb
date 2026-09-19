import { describe, it, expect, vi } from "vitest";
import {
  getCachedVersionList,
  rememberVersionList,
  versionListKey,
} from "../../src/store/versionLists";

describe("versionLists store", () => {
  it("remembers and returns a list per app+platform+region key", () => {
    expect(versionListKey(6503940939, "tvos", "JP")).toBe("6503940939:tvos:JP");
    // No region named yet: the empty bucket nothing writes into.
    expect(versionListKey(6503940939)).toBe("6503940939:ios:");

    rememberVersionList("6503940939:tvos:JP", ["a", "b"]);
    expect(getCachedVersionList("6503940939:tvos:JP")).toEqual(["a", "b"]);
    // Another region's bucket stays empty: a list is never reused across
    // storefronts.
    expect(getCachedVersionList("6503940939:tvos:US")).toBeUndefined();
  });

  it("never touches web storage", () => {
    rememberVersionList("2:ios", ["x"]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("starts empty after a reload — the cache is not reused across refreshes", async () => {
    const first = await import("../../src/store/versionLists");
    first.rememberVersionList("3:ios", ["y"]);
    expect(first.getCachedVersionList("3:ios")).toEqual(["y"]);

    // A page reload rebuilds the module graph: the cache must be gone, so the
    // next lookup fetches a fresh list from Apple.
    vi.resetModules();
    const reloaded = await import("../../src/store/versionLists");
    expect(reloaded.getCachedVersionList("3:ios")).toBeUndefined();
  });
});
