import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import InlineProgressStatus from "../../src/components/common/InlineProgressStatus";
import i18n from "../../src/i18n";

describe("InlineProgressStatus", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("keeps its reserved line empty without a stage", () => {
    const { container } = render(<InlineProgressStatus stage={null} />);

    expect(container.firstElementChild).toHaveClass("min-h-4");
    expect(container.textContent).toBe("");
  });

  it.each(["preparing", "connecting", "confirming"] as const)(
    "renders the friendly copy for %s",
    (stage) => {
      render(<InlineProgressStatus stage={stage} />);

      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(
        {
          preparing: /正在准备下载组件/,
          connecting: /正在连接 App Store/,
          confirming: /正在确认下载信息/,
        }[stage],
      );
    },
  );
});
