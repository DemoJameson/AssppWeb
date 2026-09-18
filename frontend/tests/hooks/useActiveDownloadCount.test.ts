import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveDownloadCount } from "../../src/hooks/useActiveDownloadCount";
import { useDownloadsStore } from "../../src/store/downloads";
import type { DownloadTask } from "../../src/types";

const task = (status: DownloadTask["status"]) =>
  ({ id: `${status}-${Math.random()}`, status }) as unknown as DownloadTask;

describe("useActiveDownloadCount", () => {
  beforeEach(() => {
    useDownloadsStore.setState({ tasks: [] });
  });

  it("counts queued, transferring and compiling downloads only", () => {
    useDownloadsStore.setState({
      tasks: [
        task("pending"),
        task("downloading"),
        task("injecting"),
        task("paused"),
        task("completed"),
        task("failed"),
      ],
    });

    const { result } = renderHook(() => useActiveDownloadCount());
    expect(result.current).toBe(3);
  });

  it("is zero when nothing is in progress", () => {
    useDownloadsStore.setState({
      tasks: [task("completed"), task("paused")],
    });

    const { result } = renderHook(() => useActiveDownloadCount());
    expect(result.current).toBe(0);
  });

  it("follows store updates as downloads come and go", () => {
    const { result } = renderHook(() => useActiveDownloadCount());
    expect(result.current).toBe(0);

    act(() => {
      useDownloadsStore.setState({ tasks: [task("downloading")] });
    });
    expect(result.current).toBe(1);

    act(() => {
      useDownloadsStore.setState({ tasks: [task("completed")] });
    });
    expect(result.current).toBe(0);
  });
});
