import { create } from "zustand";
import type { DownloadTask, Software, Sinf } from "../types";
import * as downloadsApi from "../api/downloads";

/**
 * Statuses that count as "downloading" wherever the UI asks: queued, actively
 * transferring, or being compiled. Paused and terminal states do not count.
 */
const ACTIVE_DOWNLOAD_STATUSES: ReadonlySet<DownloadTask["status"]> = new Set([
  "pending",
  "downloading",
  "injecting",
]);

export function isActiveDownload(task: DownloadTask): boolean {
  return ACTIVE_DOWNLOAD_STATUSES.has(task.status);
}

interface DownloadsState {
  tasks: DownloadTask[];
  loading: boolean;
  accountHashes: string[];
  setAccountHashes: (hashes: string[]) => void;
  fetchTasks: () => Promise<void>;
  startDownload: (data: {
    software: Software;
    accountHash: string;
    downloadURL: string;
    sinfs: Sinf[];
  }) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  deleteDownload: (id: string) => Promise<void>;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;
// The list request currently in flight, which a newer one cancels. It is also
// what the poll below checks before asking again — see there.
let inFlight: AbortController | null = null;

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  tasks: [],
  loading: false,
  accountHashes: [],

  setAccountHashes: (hashes) => set({ accountHashes: hashes }),

  fetchTasks: async () => {
    const { accountHashes } = get();
    // A newer read supersedes this one: it owns the state from here, and the
    // aborted request must not write anything back (it would be older data, and
    // it would clear the replacement's loading flag).
    inFlight?.abort();
    const abort = new AbortController();
    inFlight = abort;
    set({ loading: true });
    try {
      const tasks = await downloadsApi.fetchDownloads(accountHashes, {
        signal: abort.signal,
      });
      if (inFlight !== abort) return;
      set({ tasks, loading: false });

      const hasActive = tasks.some(isActiveDownload);
      if (hasActive && !pollInterval) {
        pollInterval = setInterval(() => {
          // Never while one is still out. The interval is shorter than a slow
          // response, so asking anyway would have each tick abort the tick
          // before it and the list would never take an answer at all — the
          // reported failure was exactly that: a list frozen behind a spinner.
          // A poll is a refresh, not a deadline, so the next tick asks instead.
          if (!inFlight) void get().fetchTasks();
        }, 2000);
      } else if (!hasActive && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    } catch {
      // Only the current read speaks for the store. A superseded one leaves
      // both the list and the loading flag to its replacement.
      if (inFlight !== abort) return;
      set({ loading: false });
    } finally {
      if (inFlight === abort) inFlight = null;
    }
  },

  startDownload: async (data) => {
    await downloadsApi.startDownload(data);
    await get().fetchTasks();
  },

  pauseDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.pauseDownload(id, task.accountHash);
    await get().fetchTasks();
  },

  resumeDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.resumeDownload(id, task.accountHash);
    await get().fetchTasks();
  },

  deleteDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.deleteDownload(id, task.accountHash);
    set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },
}));
