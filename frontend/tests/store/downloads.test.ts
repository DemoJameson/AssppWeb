import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadsStore, isActiveDownload } from "../../src/store/downloads";
import * as downloadsApi from "../../src/api/downloads";
import type { DownloadTask } from "../../src/types";

vi.mock("../../src/api/downloads", () => ({
  fetchDownloads: vi.fn(),
  startDownload: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  deleteDownload: vi.fn(),
}));

const fetchDownloads = vi.mocked(downloadsApi.fetchDownloads);

function task(id: string, status: DownloadTask["status"]): DownloadTask {
  return {
    id,
    software: {
      id: 1492142120,
      bundleID: "com.example.utility",
      name: "Example",
      version: "1.0",
      artistName: "",
      description: "",
      averageUserRating: 0,
      userRatingCount: 0,
      artworkUrl: "",
      screenshotUrls: [],
      minimumOsVersion: "16.0",
      fileSizeBytes: "1024",
      releaseDate: "2026-08-01T00:00:00Z",
      primaryGenreName: "Utilities",
    },
    accountHash: "account-hash-123",
    status,
    progress: 0,
    speed: "",
    createdAt: "2026-08-02T00:00:00Z",
  };
}

/** A list read that only answers when the test says so. */
function deferredRead() {
  let settle: (tasks: DownloadTask[]) => void = () => {};
  let signal: AbortSignal | undefined;
  fetchDownloads.mockImplementation((_hashes, options) => {
    signal = options?.signal;
    return new Promise<DownloadTask[]>((resolve) => {
      settle = resolve;
    });
  });
  return {
    get signal() {
      return signal;
    },
    answer(tasks: DownloadTask[]) {
      settle(tasks);
    },
  };
}

describe("downloads store polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Implementations too, not just call history: each test gives the read its
    // own behaviour and must not inherit the previous one's.
    vi.resetAllMocks();
    useDownloadsStore.setState({ tasks: [], loading: false, accountHashes: [] });
  });

  afterEach(async () => {
    // The poll is started by a list that holds an active task and stopped by one
    // that does not, so answering with a settled list ends it — otherwise the
    // interval outlives the test and the next one starts from a live store.
    fetchDownloads.mockResolvedValue([task("settled", "completed")]);
    await useDownloadsStore.getState().fetchTasks();
    vi.useRealTimers();
  });

  it("counts a queued task as active, like the store's own list does", () => {
    // `pending` is brief but real: the server answers 201 with it before the
    // transfer starts, and a row that ignored it would draw no progress at all.
    expect(isActiveDownload(task("a", "pending"))).toBe(true);
    expect(isActiveDownload(task("b", "downloading"))).toBe(true);
    expect(isActiveDownload(task("c", "injecting"))).toBe(true);
    expect(isActiveDownload(task("d", "paused"))).toBe(false);
    expect(isActiveDownload(task("e", "completed"))).toBe(false);
    expect(isActiveDownload(task("f", "failed"))).toBe(false);
  });

  it("does not let the poll abort the read it is still waiting on", async () => {
    // The regression: with a response slower than the interval, every tick
    // aborted the tick before it, no answer was ever taken, and the list sat
    // behind a spinner that never cleared.
    useDownloadsStore.getState().setAccountHashes(["account-hash-123"]);
    const read = deferredRead();

    useDownloadsStore.getState().fetchTasks();
    read.answer([task("a", "downloading")]);
    await vi.advanceTimersByTimeAsync(0);

    expect(useDownloadsStore.getState().tasks).toHaveLength(1);

    // Four intervals with that read's answer outstanding: no further request,
    // and the one in flight is never aborted.
    const read2 = fetchDownloads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    const inFlight = deferredRead();
    void useDownloadsStore.getState().fetchTasks();
    await vi.advanceTimersByTimeAsync(4 * 2000);

    expect(fetchDownloads.mock.calls.length).toBe(read2 + 1);
    expect(inFlight.signal?.aborted).toBe(false);
  });

  it("lets a newer read supersede an outstanding one", async () => {
    useDownloadsStore.getState().setAccountHashes(["account-hash-123"]);
    const first = deferredRead();

    const pending = useDownloadsStore.getState().fetchTasks();
    const second = deferredRead();
    const superseding = useDownloadsStore.getState().fetchTasks();

    expect(first.signal?.aborted).toBe(true);

    second.answer([task("b", "completed")]);
    await superseding;

    expect(useDownloadsStore.getState().tasks.map((t) => t.id)).toEqual(["b"]);
    expect(useDownloadsStore.getState().loading).toBe(false);

    // The superseded read's answer is discarded and cannot clear the flag.
    first.answer([]);
    await pending;
    expect(useDownloadsStore.getState().tasks.map((t) => t.id)).toEqual(["b"]);
  });

  it("clears the loading flag when a read fails", async () => {
    useDownloadsStore.getState().setAccountHashes(["account-hash-123"]);
    fetchDownloads.mockRejectedValue(new Error("offline"));

    await useDownloadsStore.getState().fetchTasks();

    expect(useDownloadsStore.getState().loading).toBe(false);
  });
});