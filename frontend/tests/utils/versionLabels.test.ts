import { describe, it, expect } from "vitest";
import i18n from "../../src/i18n";
import {
  versionOptionLabel,
  versionRowLabel,
} from "../../src/utils/versionLabels";
import type { VersionMetadata } from "../../src/types";

const meta: VersionMetadata = {
  displayVersion: "8.2.1",
  // The exchange's value dates the *app*: the same day comes back for every
  // version of a list. The labels only print a date a package vouched for.
  releaseDate: "2025-06-12T00:00:00.000Z",
};

describe("versionOptionLabel", () => {
  it("prints the date a package vouched for", () => {
    expect(
      versionOptionLabel("894041913", { ...meta, source: "package" }),
    ).toBe("8.2.1 (894041913) · 2025-06-12");
  });

  it("keeps the day, dropping the timestamp", () => {
    expect(
      versionOptionLabel("894041913", { ...meta, source: "package" }),
    ).not.toContain("T00:00:00");
  });

  it("prints no date for the exchange's app-level value", () => {
    // Without a package read the date is the same for every row of an app —
    // showing it would present the app's release day as the build's.
    expect(versionOptionLabel("894041913", { ...meta, source: "client" })).toBe(
      "8.2.1 (894041913)",
    );
    expect(versionOptionLabel("894041913", meta)).toBe("8.2.1 (894041913)");
  });

  it("keeps the raw id when not cached", () => {
    expect(versionOptionLabel("894041913")).toBe("894041913");
  });

  it("shows a fetching marker while the id is being looked up", () => {
    expect(versionOptionLabel("894041913", undefined, true)).toBe(
      `894041913 · ${i18n.t("search.versions.fetching")}`,
    );
  });
});

describe("versionRowLabel", () => {
  it("reads like the option label: display version, id, package date", () => {
    expect(
      versionRowLabel("889912345", { ...meta, source: "package" }),
    ).toBe("8.2.1 (889912345) · 2025-06-12");
  });

  it("prints no date for the exchange's app-level value", () => {
    expect(versionRowLabel("889912345", meta)).toBe("8.2.1 (889912345)");
  });

  it("falls back to showing the raw id when not cached", () => {
    expect(versionRowLabel("894041877")).toBe("894041877");
  });

  it("shows a fetching marker while the id is being looked up", () => {
    expect(versionRowLabel("894041877", undefined, true)).toBe(
      `894041877 · ${i18n.t("search.versions.fetching")}`,
    );
  });
});
