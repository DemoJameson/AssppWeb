import { describe, it, expect } from "vitest";
import {
  versionOptionLabel,
  versionRowLabel,
} from "../../src/utils/versionLabels";
import type { VersionMetadata } from "../../src/types";

const meta: VersionMetadata = {
  displayVersion: "8.2.1",
  releaseDate: "2025-06-12T00:00:00.000Z",
};

describe("versionOptionLabel", () => {
  it("leads with the display version and release date when cached", () => {
    expect(versionOptionLabel("894041913", meta)).toBe(
      "v8.2.1 · 2025-06-12 (894041913)",
    );
  });

  it("keeps the raw id when not cached", () => {
    expect(versionOptionLabel("894041913")).toBe("894041913");
  });
});

describe("versionRowLabel", () => {
  it("leads with the display version and the id in parentheses when cached", () => {
    expect(versionRowLabel("889912345", meta)).toBe("v8.2.1 (889912345)");
  });

  it("falls back to showing the raw id when not cached", () => {
    expect(versionRowLabel("894041877")).toBe("894041877");
  });
});
