import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import SapStatus from "../../src/components/common/SapStatus";
import { useSapStore } from "../../src/store/sap";
import i18n from "../../src/i18n";

describe("SapStatus", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    useSapStore.setState({
      stage: "idle",
      percent: null,
      error: null,
      hardwareID: null,
    });
  });

  it("renders nothing when idle or ready", () => {
    const { container, rerender } = render(<SapStatus />);
    expect(container).toBeEmptyDOMElement();

    act(() => useSapStore.setState({ stage: "ready" }));
    rerender(<SapStatus />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows download progress while the assets load", () => {
    useSapStore.setState({ stage: "assets", percent: 42 });
    render(<SapStatus />);
    expect(screen.getByText(/正在准备签名组件 42%/)).toBeInTheDocument();
  });

  it("shows the setup note while the signer initializes", () => {
    useSapStore.setState({ stage: "setup" });
    render(<SapStatus />);
    expect(screen.getByText(/正在初始化签名器/)).toBeInTheDocument();
  });

  it("positions the line absolutely so it never displaces the layout", () => {
    useSapStore.setState({ stage: "setup" });
    render(<SapStatus />);
    expect(screen.getByText(/正在初始化签名器/).className).toContain(
      "absolute",
    );
  });

  it("shows a truncated error line with the full text in the title", () => {
    useSapStore.setState({ stage: "error", error: "boom" });
    render(<SapStatus />);
    const line = screen.getByText(/签名组件准备失败/);
    expect(line).toBeInTheDocument();
    expect(line.getAttribute("title")).toContain("boom");
    expect(line.className).toContain("truncate");
  });
});
