import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import StableLabel from "../../src/components/common/StableLabel";

describe("StableLabel", () => {
  it("swaps which label is visible", () => {
    const { rerender } = render(
      <StableLabel idle="下载" busy="处理中..." busyActive={false} />,
    );
    expect(
      screen.getByText("下载", { ignore: "[aria-hidden='true']" }),
    ).toBeTruthy();

    rerender(<StableLabel idle="下载" busy="处理中..." busyActive />);
    expect(
      screen.getByText("处理中...", { ignore: "[aria-hidden='true']" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("下载", { ignore: "[aria-hidden='true']" }),
    ).toBeNull();
  });

  it("keeps both labels in the layout as hidden sizers", () => {
    const { container } = render(
      <StableLabel idle="下载" busy="处理中..." busyActive={false} />,
    );
    const sizers = container.querySelectorAll("[aria-hidden='true']");
    expect(sizers).toHaveLength(2);
    for (const sizer of sizers) {
      expect(sizer.className).toContain("invisible");
    }
    expect(container.textContent).toContain("处理中...");
  });
});
