import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import InlineProgressStatus from "../../src/components/common/InlineProgressStatus";
import i18n from "../../src/i18n";

describe("InlineProgressStatus", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("keeps its reserved line empty without a stage", () => {
    const { container } = render(<InlineProgressStatus progress={null} />);

    expect(container.firstElementChild).toHaveClass("min-h-4");
    expect(container.textContent).toBe("");
  });

  it("renders preparation with a percentage and no duplicate spinner", () => {
    const { container } = render(
      <InlineProgressStatus
        progress={{ stage: "preparing", percent: 42 }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "正在准备下载组件…",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );

    const text = container.querySelector("p");
    expect(text).toHaveTextContent("正在准备下载组件 42%");
    expect(text).toHaveAttribute("aria-hidden", "true");
    expect(text?.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(text).toHaveClass("tabular-nums");
    expect(text?.lastElementChild).toHaveClass("shrink-0");
    expect(container.firstElementChild).toHaveClass("min-h-4");
  });

  it("falls back to copy without a percentage when none is measurable", () => {
    render(
      <InlineProgressStatus progress={{ stage: "preparing", percent: null }} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/正在准备下载组件/);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it.each(["initializing", "connecting", "confirming"] as const)(
    "renders the friendly copy for %s without a spinner",
    (stage) => {
      const { container } = render(
        <InlineProgressStatus progress={{ stage, percent: null }} />,
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        {
          initializing: /正在初始化下载组件/,
          connecting: /正在连接 App Store/,
          confirming: /正在确认下载信息/,
        }[stage],
      );
      expect(
        container.querySelector("p .animate-spin"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    },
  );
});
