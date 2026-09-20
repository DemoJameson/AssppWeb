import { describe, expect, it } from "vitest";
import {
  downloadedBuilds,
  findDuplicateDownload,
  isBuildDownloaded,
  tasksForApp,
} from "../../src/utils/downloaded";
import type { DownloadTask, Platform, Software } from "../../src/types";

const app: Software = {
  id: 42,
  bundleID: "com.example.app",
  name: "Example",
  version: "1.2.3",
  artistName: "Example",
  sellerName: "Example",
  description: "",
  averageUserRating: 0,
  userRatingCount: 0,
  artworkUrl: "",
  screenshotUrls: [],
  minimumOsVersion: "16.0",
  releaseDate: "",
  primaryGenreName: "Utilities",
  platform: "ios",
};

interface TaskOverrides {
  id?: string;
  status?: DownloadTask["status"];
  hasFile?: boolean;
  appId?: number;
  /** `null` is a package that predates the field — nothing recorded. */
  platform?: Platform | null;
  externalVersionId?: string | null;
  version?: string | null;
}

function task(overrides: TaskOverrides = {}): DownloadTask {
  const software: Software = { ...app };
  software.id = overrides.appId ?? app.id;
  if (overrides.platform !== undefined) software.platform = overrides.platform ?? undefined;
  const externalVersionId =
    overrides.externalVersionId === undefined ? "900" : overrides.externalVersionId;
  if (externalVersionId !== null)
    software.externalVersionId = externalVersionId;
  if (overrides.version !== undefined) software.version = overrides.version ?? "";
  return {
    id: overrides.id ?? "task-1",
    software,
    accountHash: "hash",
    status: overrides.status ?? "completed",
    progress: 100,
    speed: "",
    hasFile: overrides.hasFile ?? true,
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

describe("tasksForApp", () => {
  it("keeps only the app's own tasks", () => {
    const own = task();
    const foreign = task({ id: "foreign", appId: 43 });
    expect(tasksForApp([own, foreign], 42, "ios")).toEqual([own]);
  });

  it("drops a package built for another platform", () => {
    expect(tasksForApp([task({ platform: "tvos" })], 42, "ios")).toEqual([]);
  });

  it("keeps a package that predates platform recording", () => {
    // Such a package cannot contradict the platform on screen, so it stays a
    // candidate rather than being ruled out by a field it never had.
    const legacy = task({ platform: null });
    expect(tasksForApp([legacy], 42, "ios")).toEqual([legacy]);
  });
});

describe("downloadedBuilds", () => {
  it("names the builds the server holds", () => {
    const builds = downloadedBuilds(
      [task(), task({ id: "b", externalVersionId: "800" })],
      42,
      "ios",
    );
    expect(Array.from(builds.ids).sort()).toEqual(["800", "900"]);
    expect(builds.versions.size).toBe(0);
  });

  it("falls back to the number of a package that has no id", () => {
    // Two builds can carry the same number, so this fallback cannot tell them
    // apart — every build wearing that number counts as held.
    const builds = downloadedBuilds(
      [task({ externalVersionId: null, version: "1.2.3" })],
      42,
      "ios",
    );
    expect(isBuildDownloaded(builds, "900", "1.2.3")).toBe(true);
    expect(isBuildDownloaded(builds, "900", "1.2.2")).toBe(false);
    expect(isBuildDownloaded(builds, "900")).toBe(false);
  });

  it("ignores a finished task whose file is gone", () => {
    expect(downloadedBuilds([task({ hasFile: false })], 42, "ios").ids.size).toBe(0);
  });

  it("ignores a task that never finished", () => {
    expect(
      downloadedBuilds([task({ status: "downloading" })], 42, "ios").ids.size,
    ).toBe(0);
  });
});

describe("findDuplicateDownload", () => {
  it("finds the package of the pinned build", () => {
    const held = task({ id: "held", externalVersionId: "800" });
    expect(findDuplicateDownload([held], app, "800")).toBe(held);
    expect(findDuplicateDownload([held], app, "700")).toBeUndefined();
  });

  it("matches the record's own version when nothing is pinned", () => {
    const held = task({ id: "held", version: "1.2.3", externalVersionId: "900" });
    expect(findDuplicateDownload([held], app)).toBe(held);
    expect(findDuplicateDownload([held], { ...app, version: "1.2.4" })).toBeUndefined();
  });

  it("does not match a pinned build by the record's version", () => {
    // The record names the newest build; a pin further down the list asks for a
    // different package, so only the external id may speak for it.
    const held = task({ id: "held", version: "1.2.3" });
    expect(findDuplicateDownload([held], app, "700")).toBeUndefined();
  });

  it("blocks a download that is still running", () => {
    const running = task({ id: "running", status: "downloading", version: "1.2.3" });
    expect(findDuplicateDownload([running], app)).toBe(running);
  });

  it("leaves the way open after a failure", () => {
    const failed = task({ id: "failed", status: "failed", version: "1.2.3" });
    expect(findDuplicateDownload([failed], app)).toBeUndefined();
  });

  it("does not answer when the build cannot be named", () => {
    const held = task({ id: "held", version: "" });
    expect(findDuplicateDownload([held], { ...app, version: "" })).toBeUndefined();
  });
});
