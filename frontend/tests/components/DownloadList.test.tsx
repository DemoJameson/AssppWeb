import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DownloadList from "../../src/components/Download/DownloadList";
import type { DownloadTask } from "../../src/types";

const mocks = vi.hoisted(() => ({
  tasks: [] as DownloadTask[],
}));

// The stub interpolates, so the counted labels stay distinguishable.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../src/hooks/useDownloads", () => ({
  useDownloads: () => ({
    tasks: mocks.tasks,
    loading: false,
    pauseDownload: vi.fn(),
    resumeDownload: vi.fn(),
    deleteDownload: vi.fn(),
    hashToEmail: () => undefined,
  }),
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({ accounts: [] }),
}));

vi.mock("../../src/hooks/useDownloadAction", () => ({
  useDownloadAction: () => ({ startDownload: vi.fn() }),
}));

vi.mock("../../src/store/toast", () => ({
  useToastStore: (selector: (state: { addToast: () => void }) => unknown) =>
    selector({ addToast: vi.fn() }),
}));

// The list's own item is heavy; the filter only needs to show what it renders.
vi.mock("../../src/components/Download/DownloadItem", () => ({
  default: ({ task }: { task: DownloadTask }) => (
    <div>{task.software.name}</div>
  ),
}));

function task(
  id: string,
  name: string,
  status: DownloadTask["status"],
): DownloadTask {
  return {
    id,
    status,
    software: { id: 1, name },
    accountHash: "hash",
    progress: 0,
    speed: "",
    createdAt: "2026-01-01T00:00:00Z",
  } as unknown as DownloadTask;
}

function renderList() {
  return render(
    <MemoryRouter>
      <DownloadList />
    </MemoryRouter>,
  );
}

describe("DownloadList status filter", () => {
  beforeEach(() => {
    mocks.tasks = [
      task("1", "Alpha", "completed"),
      task("2", "Bravo", "downloading"),
      task("3", "Charlie", "injecting"),
      task("4", "Delta", "failed"),
    ];
  });

  it("offers the buckets with their counts in one control", () => {
    renderList();

    fireEvent.click(screen.getByRole("combobox", { name: "downloads.filter" }));

    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");

    expect(labels).toHaveLength(5);
    // 全部 counts everything; 进行中 is the queue/transfer/compile bucket, so
    // the transferring and injecting tasks both land in it.
    expect(labels[0]).toContain('"count":4');
    expect(
      labels.some(
        (label) =>
          label.includes("downloads.filterActive") &&
          label.includes('"count":2'),
      ),
    ).toBe(true);
    expect(
      labels.some(
        (label) =>
          label.includes("downloads.status.paused") &&
          label.includes('"count":0'),
      ),
    ).toBe(true);
    expect(
      labels.some(
        (label) =>
          label.includes("downloads.status.completed") &&
          label.includes('"count":1'),
      ),
    ).toBe(true);
    expect(
      labels.some(
        (label) =>
          label.includes("downloads.status.failed") &&
          label.includes('"count":1'),
      ),
    ).toBe(true);
    // The exact statuses live in the row badge; the menu does not list them.
    expect(
      labels.some((label) => label.includes("downloads.status.injecting")),
    ).toBe(false);
  });

  it("counts injecting as in progress", () => {
    renderList();

    fireEvent.click(screen.getByRole("combobox", { name: "downloads.filter" }));
    fireEvent.click(
      screen.getByRole("option", { name: /downloads\.filterActive/ }),
    );

    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.getByText("Charlie")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Delta")).toBeNull();
  });

  it("narrows the list to a finished status", () => {
    renderList();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Bravo")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "downloads.filter" }));
    fireEvent.click(
      screen.getByRole("option", { name: /downloads\.status\.completed/ }),
    );

    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();
  });
});
