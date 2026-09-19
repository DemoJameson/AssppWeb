import { describe, expect, it } from "vitest";
import {
  formatDateISO,
  formatDateTimeISO,
} from "../../src/utils/software";

describe("formatDateISO", () => {
  it("prints the local calendar day as YYYY-MM-DD", () => {
    expect(formatDateISO("2026-09-17T00:00:00Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDateISO("2026-09-17")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Zero-padded regardless of locale (toLocaleDateString would give 2026/9/17).
    expect(formatDateISO("2026-09-17T00:00:00Z")).not.toContain("/");
  });

  it("is undefined for non-dates, so callers keep their fallback", () => {
    expect(formatDateISO("")).toBeUndefined();
    expect(formatDateISO("not a date")).toBeUndefined();
  });
});

describe("formatDateTimeISO", () => {
  it("appends the zero-padded local time to the ISO date", () => {
    const stamp = new Date(2026, 8, 19, 4, 16, 57).toISOString();
    expect(formatDateTimeISO(stamp)).toBe("2026-09-19 04:16:57");
  });

  it("is undefined for non-dates", () => {
    expect(formatDateTimeISO("nope")).toBeUndefined();
  });
});
