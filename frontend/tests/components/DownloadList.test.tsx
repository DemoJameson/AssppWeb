import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DownloadList from "../../src/components/Download/DownloadList";
import type { Account, DownloadTask, Software } from "../../src/types";

const mocks = vi.hoisted(() => ({
  tasks: [] as DownloadTask[],
  accounts: [] as Account[],
  hashToEmail: {} as Record<string, string>,
  startDownload: vi.fn(),
  listVersionsWithLicense: vi.fn(),
  lookupNewestServableVersion: vi.fn(),
  lookupApp: vi.fn(),
  deleteDownload: vi.fn(),
  toastDownloadError: vi.fn(),
  addToast: vi.fn(),
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
    deleteDownload: mocks.deleteDownload,
    hashToEmail: mocks.hashToEmail,
  }),
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({
    accounts: mocks.accounts,
  }),
}));

vi.mock("../../src/hooks/useDownloadAction", () => ({
  useDownloadAction: () => ({
    startDownload: mocks.startDownload,
    listVersionsWithLicense: mocks.listVersionsWithLicense,
    lookupNewestServableVersion: mocks.lookupNewestServableVersion,
    toastDownloadError: mocks.toastDownloadError,
  }),
}));

// The update check's first source: the storefront, by bundle id.
vi.mock("../../src/api/search", () => ({
  lookupApp: mocks.lookupApp,
}));

// The update picker's version labels come from a cache fed by Apple's answers; the
// list only needs its shape here. (The real hook would drag libcurl into jsdom.)
vi.mock("../../src/hooks/useVersionMetadata", () => ({
  useVersionMetadataMap: () => ({
    versionMeta: {},
    pendingMeta: {},
    fillVersionsSilently: vi.fn(),
  }),
}));

vi.mock("../../src/store/toast", () => ({
  useToastStore: (selector: (state: unknown) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

// The list's own item is heavy, so the filter only shows what it renders; the mock
// echoes the highlight and the two affordances (failed/retry, settled/ask-storefront)
// under the same conditions the real item applies, keeping the text assertions honest.
vi.mock("../../src/components/Download/DownloadItem", () => ({
  default: ({
    task,
    highlight,
    onRetry,
    onCheckUpdate,
  }: {
    task: DownloadTask;
    highlight?: boolean;
    onRetry?: (id: string) => void;
    onCheckUpdate?: (id: string) => void;
  }) => (
    // The name stands alone in the flagged div: the row-text assertions of the
    // highlight tests read it whole, so an affordance must not join it.
    <>
      <div data-highlight={highlight ? "true" : "false"}>
        {task.software.name}
      </div>
      {task.status === "failed" && onRetry ? (
        <button type="button" onClick={() => onRetry(task.id)}>
          retry-{task.id}
        </button>
      ) : null}
      {task.status === "completed" && onCheckUpdate ? (
        <button type="button" onClick={() => onCheckUpdate(task.id)}>
          check-{task.id}
        </button>
      ) : null}
    </>
  ),
}));

const primaryHash = "hash";
const secondaryHash = "other-hash";
const idleHash = "idle-hash";

function account(
  email: string,
  firstName: string,
  lastName: string,
  store: string,
): Account {
  return {
    email,
    password: "",
    appleId: email,
    store,
    firstName,
    lastName,
    passwordToken: "",
    directoryServicesIdentifier: "",
    cookies: [],
    deviceIdentifier: "",
  };
}

beforeEach(() => {
  mocks.accounts = [
    account("user@example.com", "Demo", "User", "143441"),
    account("other@example.com", "Other", "Account", "143465"),
    account("idle@example.com", "Idle", "Account", "143462"),
  ];
  mocks.hashToEmail = {
    [primaryHash]: "user@example.com",
    [secondaryHash]: "other@example.com",
    [idleHash]: "idle@example.com",
  };
});

function task(
  id: string,
  name: string,
  status: DownloadTask["status"],
  accountHash = primaryHash,
): DownloadTask {
  return {
    id,
    status,
    software: { id: 1, name },
    accountHash,
    progress: 0,
    speed: "",
    createdAt: "2026-01-01T00:00:00Z",
  } as unknown as DownloadTask;
}

/** What a fresh mount of this entry would read back from the router. */
function StateProbe() {
  const location = useLocation();
  return (
    <div data-testid="router-state">
      {JSON.stringify(location.state ?? null)}
    </div>
  );
}

function listTree(state?: unknown, withProbe = false) {
  return (
    <MemoryRouter
      initialEntries={[{ pathname: "/downloads", state: state ?? null }]}
    >
      {withProbe ? <StateProbe /> : null}
      <DownloadList />
    </MemoryRouter>
  );
}

function renderList(state?: unknown, withProbe = false) {
  return render(listTree(state, withProbe));
}

describe("DownloadList account filter", () => {
  beforeEach(() => {
    mocks.tasks = [
      task("1", "Alpha", "completed", primaryHash),
      task("2", "Bravo", "downloading", secondaryHash),
      task("3", "Charlie", "injecting", primaryHash),
      task("4", "Delta", "failed", secondaryHash),
    ];
  });

  it("offers every account with its download count in one control", () => {
    renderList();

    fireEvent.click(
      screen.getByRole("combobox", { name: "downloads.accountFilter" }),
    );

    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");

    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("downloads.allAccounts");
    expect(labels[0]).toContain('"count":4');
    expect(
      labels.some(
        (label) =>
          label.includes("user@example.com") &&
          label.includes('"count":2'),
      ),
    ).toBe(true);
    expect(
      labels.some(
        (label) =>
          label.includes("other@example.com") &&
          label.includes('"count":2'),
      ),
    ).toBe(true);
    expect(
      labels.some(
        (label) =>
          label.includes("idle@example.com") &&
          label.includes('"count":0'),
      ),
    ).toBe(true);
    expect(labels.some((label) => label.includes("downloads.status."))).toBe(
      false,
    );
  });

  it("narrows the list to one account's downloads", () => {
    renderList();

    fireEvent.click(
      screen.getByRole("combobox", { name: "downloads.accountFilter" }),
    );
    fireEvent.click(
      screen.getByRole("option", { name: /other@example\.com/ }),
    );

    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.getByText("Delta")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Charlie")).toBeNull();
  });

  it("returns to all accounts when the selected account disappears", async () => {
    const view = renderList();

    fireEvent.click(
      screen.getByRole("combobox", { name: "downloads.accountFilter" }),
    );
    fireEvent.click(
      screen.getByRole("option", { name: /other@example\.com/ }),
    );

    mocks.accounts = mocks.accounts.filter(
      (item) => item.email !== "other@example.com",
    );
    mocks.hashToEmail = Object.fromEntries(
      Object.entries(mocks.hashToEmail).filter(
        ([hash]) => hash !== secondaryHash,
      ),
    );
    mocks.tasks = mocks.tasks.filter(
      (item) => item.accountHash !== secondaryHash,
    );
    view.rerender(listTree());

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "downloads.accountFilter" }),
      ).toHaveTextContent("downloads.allAccounts"),
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Charlie")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();
    expect(screen.queryByText("Delta")).toBeNull();
  });

  it("keeps a task filterable when its account is not in the account store", () => {
    const orphanHash = "orphan-hash";
    mocks.tasks = [task("orphan", "Orphan", "failed", orphanHash)];
    renderList();

    fireEvent.click(
      screen.getByRole("combobox", { name: "downloads.accountFilter" }),
    );
    const orphanOption = screen.getByRole("option", { name: /orphan-hash/ });
    expect(orphanOption.getAttribute("title")).toContain(orphanHash);
    fireEvent.click(orphanOption);

    expect(screen.getByText("Orphan")).toBeTruthy();
  });
});

describe("DownloadList highlight hop", () => {
  beforeEach(() => {
    mocks.tasks = [
      task("1", "Alpha", "completed"),
      task("2", "Bravo", "downloading"),
    ];
  });

  it("marks the package a hop from the app page named", () => {
    renderList({ highlightTaskId: "1" });

    // Only the named package wears the ring; the rest read normally.
    const rows = screen.getAllByText(/Alpha|Bravo/);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.textContent === "Alpha")).toHaveAttribute(
      "data-highlight",
      "true",
    );
    expect(rows.find((row) => row.textContent === "Bravo")).toHaveAttribute(
      "data-highlight",
      "false",
    );
  });

  it("highlights nothing on a plain visit", () => {
    renderList();

    for (const row of screen.getAllByText(/Alpha|Bravo/)) {
      expect(row).toHaveAttribute("data-highlight", "false");
    }
  });

  it("consumes the hop, so reloading that entry highlights nothing", () => {
    // The entry that carried the hop is rewritten on arrival: what a reload re-reads,
    // and what stepping back finds, names no package any more.
    const { unmount } = renderList({ highlightTaskId: "1" }, true);

    // This mount still marks the package it was pointed at.
    expect(screen.getByText("Alpha")).toHaveAttribute("data-highlight", "true");
    expect(screen.getByTestId("router-state").textContent).toBe("null");
    unmount();

    // The same entry again — what F5 gives back — leaves the row unmarked.
    renderList(null, true);
    for (const row of screen.getAllByText(/Alpha|Bravo/)) {
      expect(row).toHaveAttribute("data-highlight", "false");
    }
  });
});
describe("DownloadList retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tasks = [task("1", "Alpha", "failed")];
  });

  it("deletes the failed row once the retry is under way", async () => {
    mocks.startDownload.mockResolvedValue(undefined);
    mocks.deleteDownload.mockResolvedValue(undefined);
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "retry-1" }));

    await vi.waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({ email: "user@example.com" }),
        expect.objectContaining({ name: "Alpha" }),
        undefined,
      );
      expect(mocks.deleteDownload).toHaveBeenCalledWith("1");
    });
  });

  it("keeps the failed row when the retry itself fails", async () => {
    mocks.startDownload.mockRejectedValue(new Error("still failing"));
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "retry-1" }));

    await vi.waitFor(() => {
      expect(mocks.toastDownloadError).toHaveBeenCalled();
    });
    expect(mocks.deleteDownload).not.toHaveBeenCalled();
  });

  it("does not surface a failed cleanup beside a successful retry", async () => {
    // The retry succeeded — the new attempt already runs for this build — so
    // a stale row the deletion could not remove is not worth an error toast.
    mocks.startDownload.mockResolvedValue(undefined);
    mocks.deleteDownload.mockRejectedValue(new Error("row raced away"));
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "retry-1" }));

    await vi.waitFor(() => {
      expect(mocks.deleteDownload).toHaveBeenCalledWith("1");
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });
});

describe("DownloadList update check", () => {
  /** The app the storefront still lists: its `version` is the current one. */
  const listedApp: Software = {
    id: 1492142120,
    bundleID: "com.example.utility",
    name: "Alpha",
    version: "1.3.19",
    artistName: "Example Developer",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "16.0",
    releaseDate: "2026-08-01T00:00:00Z",
    primaryGenreName: "Utilities",
    platform: "ios",
  };

  /**
   * What the storefront no longer knows: the record is recalled from the
   * package-app index, so its `version` is the build already on disk — the very
   * build the row holds.
   */
  const recalledApp: Software = {
    ...listedApp,
    version: "1.3.18",
    externalVersionId: "1",
    metadataSource: "local",
  };

  /**
   * The finished 1.3.18 package the row stands for. `null` is a package
   * compiled before the external version id was recorded: the row then names no
   * build.
   */
  function completedTask(buildId: string | null = "1"): DownloadTask {
    return {
      id: "1",
      software: {
        ...recalledApp,
        name: "Alpha",
        externalVersionId: buildId ?? undefined,
      },
      accountHash: "hash",
      status: "completed",
      progress: 100,
      speed: "",
      createdAt: "2026-09-01T00:00:00Z",
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tasks = [completedTask()];
    mocks.startDownload.mockResolvedValue(undefined);
    mocks.deleteDownload.mockResolvedValue(undefined);
  });

  it("takes a delisted app's newest build from the version exchange", async () => {
    // The package-app index can only describe the build already here, so the storefront's
    // fallback is no comparison: the exchange names the build the app has moved on to.
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "2",
      displayVersion: "1.3.19",
      versions: ["2", "1"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    expect(mocks.lookupNewestServableVersion).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" }),
      expect.objectContaining({ metadataSource: "local" }),
      // The build on disk: the pin a delisted app is still reachable through.
      "1",
    );
    // The exchange carried a list, so the storefront's is not asked for again.
    expect(mocks.listVersionsWithLicense).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalledWith(
      "downloads.package.noUpdate",
      "info",
    );
  });

  it("fetches the build the user picked by its id", async () => {
    // Unpinned, the request would resolve the pin a past download recorded — the build
    // already on disk — so a delisted app's update must name the build it wants.
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "2",
      displayVersion: "1.3.19",
      versions: ["2", "1"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "downloads.package.update" }),
    );

    await waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({ email: "user@example.com" }),
        expect.objectContaining({ metadataSource: "local" }),
        "2",
      );
      expect(mocks.deleteDownload).toHaveBeenCalledWith("1");
    });
  });

  it("reports the latest version when the list names nothing newer", async () => {
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "1",
      versions: ["1"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith(
        "downloads.package.noUpdate",
        "info",
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("places the held build in the list when no version number came back", async () => {
    // No number to compare: the held build's own place in the list is what says
    // whether anything sits above it — here it is first, so nothing does.
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "1",
      versions: ["1", "0"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith(
        "downloads.package.noUpdate",
        "info",
      );
    });
  });

  it("does not call a build it cannot compare an update", async () => {
    // A package compiled before version ids were recorded: with no number and no id of its
    // own, a newest build that is merely *different* could be older — offering it is unsafe.
    mocks.tasks = [completedTask(null)];
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "2",
      versions: ["2", "1"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith(
        "downloads.package.checkUpdateFailed",
        "error",
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the row when the update picks the build it already holds", async () => {
    // The list a recalled record offers is the app's own, so it can name the build this
    // row holds — asking for that one is refused as a duplicate, and deleting the row
    // on that would remove the only handle on a package nothing replaced.
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "1",
      displayVersion: "1.3.19",
      versions: ["1", "0"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "downloads.package.update" }),
    );

    await waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({ email: "user@example.com" }),
        expect.objectContaining({ metadataSource: "local" }),
        "1",
      );
    });
    expect(mocks.deleteDownload).not.toHaveBeenCalled();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("does not read a check that could not be made as the latest version", async () => {
    // Nothing knows the app: the storefront has forgotten it and nothing here
    // ever downloaded it. That is not a verdict about versions.
    mocks.lookupApp.mockResolvedValue(null);

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith(
        "downloads.package.checkUpdateFailed",
        "error",
      );
    });
    expect(mocks.addToast).not.toHaveBeenCalledWith(
      "downloads.package.noUpdate",
      "info",
    );
  });

  it("does not read a list that names no build as the latest version", async () => {
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue(undefined);

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith(
        "downloads.package.checkUpdateFailed",
        "error",
      );
    });
  });

  it("keeps asking the storefront first for an app it still lists", async () => {
    // A listed app's own record is the answer, and the platform travels with
    // the lookup so a macOS or tvOS row is not answered with the iOS build.
    mocks.lookupApp.mockResolvedValue(listedApp);
    mocks.listVersionsWithLicense.mockResolvedValue({ versions: ["2", "1"] });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "check-1" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    expect(mocks.lookupApp).toHaveBeenCalledWith(
      "com.example.utility",
      "US",
      "ios",
    );
    expect(mocks.lookupNewestServableVersion).not.toHaveBeenCalled();
    expect(mocks.listVersionsWithLicense).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" }),
      listedApp,
    );
  });

  it("updates a delisted app in the bulk check too", async () => {
    mocks.lookupApp.mockResolvedValue(recalledApp);
    mocks.lookupNewestServableVersion.mockResolvedValue({
      versionId: "2",
      displayVersion: "1.3.19",
      versions: ["2", "1"],
    });

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "downloads.checkUpdates" }));

    // The loop paces itself between apps to stay clear of rate limits.
    await waitFor(
      () => {
        expect(mocks.startDownload).toHaveBeenCalledWith(
          expect.objectContaining({ email: "user@example.com" }),
          recalledApp,
          "2",
        );
        expect(mocks.deleteDownload).toHaveBeenCalledWith("1");
      },
      { timeout: 8000 },
    );
  });
});
