import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps its reserved line empty when idle or ready", () => {
    const { container, rerender } = render(<SapStatus />);
    // The slot is always in the layout — that is what keeps the buttons above
    // it from moving when a message comes and goes.
    expect(container.firstElementChild?.className).toContain("min-h-4");
    expect(container.textContent).toBe("");

    act(() => useSapStore.setState({ stage: "ready" }));
    rerender(<SapStatus />);
    expect(container.textContent).toBe("");
  });

  it("explains the first-run download while the assets load", () => {
    useSapStore.setState({ stage: "assets", percent: 42 });
    render(<SapStatus />);

    // The percentage rides on the submit button; this line explains the wait.
    expect(screen.getByRole("status")).toHaveTextContent(
      /首次使用需准备签名组件/,
    );
  });

  it("stays quiet while the signer initializes, which the button reports", () => {
    useSapStore.setState({ stage: "setup" });
    const { container } = render(<SapStatus />);

    expect(container.textContent).toBe("");
  });

  it("shows the whole error and offers a retry", () => {
    useSapStore.setState({ stage: "error", error: "boom" });
    const onRetry = vi.fn();
    render(<SapStatus onRetry={onRetry} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/签名组件准备失败/);
    expect(alert).toHaveTextContent(/boom/);
    // The actionable part must not be cut off by a truncation.
    expect(alert.querySelector("span")?.className).not.toContain("truncate");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry when the caller has nothing to retry with", () => {
    useSapStore.setState({ stage: "error", error: "boom" });
    render(<SapStatus />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});
