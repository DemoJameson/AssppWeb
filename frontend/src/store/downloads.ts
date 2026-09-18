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
// Aborts the in-flight list request when a newer one starts, so a slow older
// response can never overwrite fresher state.
let fetchAbort: AbortController | null = null;

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  tasks: [],
  loading: false,
  accountHashes: [],

  setAccountHashes: (hashes) => set({ accountHashes: hashes }),

  fetchTasks: async () => {
    const { accountHashes } = get();
    fetchAbort?.abort();
    const abort = new AbortController();
    fetchAbort = abort;
    set({ loading: true });
    try {
      const tasks = await downloadsApi.fetchDownloads(accountHashes, {
        signal: abort.signal,
      });
      set({ tasks, loading: false });

      const hasActive = tasks.some(isActiveDownload);
      if (hasActive && !pollInterval) {
        pollInterval = setInterval(() => {
          get().fetchTasks();
        }, 2000);
      } else if (!hasActive && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    } catch (err) {
      // A superseded request must not clear the loading state of its
      // replacement.
      if (err instanceof Error && err.name === "AbortError") return;
      set({ loading: false });
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
