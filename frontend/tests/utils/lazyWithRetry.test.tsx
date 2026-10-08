import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// A stable `t` — react-i18next stores it in useState, so a fresh arrow
// function per render would give the fallback a new identity every time.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// The automatic reload is production-only. Vitest runs with MODE=test and
// PROD=false, so without this stub the reload branch would be dead code here
// and every reload assertion below would pass vacuously.
vi.stubEnv("PROD", true);

const { default: AppErrorBoundary } = await import(
  "../../src/components/common/AppErrorBoundary"
);
const { lazyWithRetry, resetReloadGuardForTests } = await import(
  "../../src/utils/lazyWithRetry"
);

/**
 * The failure under test: a route chunk request dies (edge 521, ERR_ABORTED),
 * `import()` rejects, and — before this module existed — React tore down the
 * whole tree because nothing above `<Suspense>` could catch it.
 */

function Boom(): React.ReactElement {
  throw new Error("render exploded");
}

const chunkError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: https://x/assets/DownloadList.js",
  );

beforeEach(() => {
  resetReloadGuardForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Renders the lazy component and drives the retries out.
 *
 * Note what does NOT happen on the reload path: once `lazyWithRetry` has
 * decided to reload it resolves to a promise that never settles, so no error
 * reaches React. A test that exercises that path therefore ends with the
 * fallback still on screen and nothing thrown — which is the intended
 * behaviour (do not flash an error at someone who is already getting a new
 * page). Paths that do surface an error are asserted with `.rejects` below.
 */
async function renderLazy(
  Comp: React.ComponentType,
  attempts = 4,
): Promise<void> {
  const { rerender } = render(
    <React.Suspense fallback={<span>loading</span>}>
      <Comp />
    </React.Suspense>,
  );
  // Each retry waits BASE_DELAY * attempt, so flush generously.
  for (let i = 0; i < attempts; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    rerender(
      <React.Suspense fallback={<span>loading</span>}>
        <Comp />
      </React.Suspense>,
    );
  }
  // No unmount here: assertions run against this tree, and testing-library
  // cleans it up between tests.
}

/**
 * Renders a lazy component that is expected to fail terminally, through the
 * real AppErrorBoundary.
 *
 * Using the production boundary (rather than a local stand-in) is deliberate:
 * it proves the two pieces actually compose — that a chunk failure rejected by
 * lazyWithRetry is caught and rendered as the recovery panel instead of
 * unmounting the tree into a blank page, which is the bug being fixed.
 */
async function renderLazyExpectingThrow(
  Comp: React.ComponentType,
  attempts = 4,
): Promise<unknown> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { rerender } = render(
    <AppErrorBoundary>
      <React.Suspense fallback={<span>loading</span>}>
        <Comp />
      </React.Suspense>
    </AppErrorBoundary>,
  );
  for (let i = 0; i < attempts; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    rerender(
      <AppErrorBoundary>
        <React.Suspense fallback={<span>loading</span>}>
          <Comp />
        </React.Suspense>
      </AppErrorBoundary>,
    );
  }
  spy.mockRestore();
  return document.body.textContent;
}

describe("lazyWithRetry", () => {
  it("renders the component when the import succeeds first time", async () => {
    const Good = lazyWithRetry(async () => ({ default: () => <p>tab body</p> }));
    await renderLazy(Good, 1);
    expect(screen.getByText("tab body")).toBeTruthy();
  });

  it("recovers when an early attempt fails and a later one succeeds", async () => {
    let calls = 0;
    const Flaky = lazyWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("Failed to fetch dynamically imported module");
      return { default: () => <p>recovered body</p> };
    });

    await renderLazy(Flaky);

    // 3 attempts total: two failures, then success. The retry is what makes
    // this pass — without it the first rejection is terminal.
    expect(calls).toBe(3);
    expect(screen.getByText("recovered body")).toBeTruthy();
  });

  it("retries a bounded number of times before giving up", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    let calls = 0;
    const AlwaysFails = lazyWithRetry(async () => {
      calls += 1;
      throw chunkError();
    });

    await renderLazy(AlwaysFails, 6);

    // Bounded: 3 attempts, not one per render. An unbounded retry against a
    // dead origin would hang the tab forever instead of surfacing an error.
    expect(calls).toBe(3);
  });

  it("reloads once for a chunk-load failure so a stale build can recover", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    let calls = 0;
    const Stale = lazyWithRetry(async () => {
      calls += 1;
      throw chunkError();
    });

    await renderLazy(Stale, 4);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
    expect(window.sessionStorage.getItem("asspp:chunk-reload")).toBe("1");
  });

  it("does not reload twice within a session", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    // First component exhausts its retries and triggers the reload.
    const First = lazyWithRetry(async () => {
      throw chunkError();
    });
    await renderLazy(First, 4);
    expect(reload).toHaveBeenCalledTimes(1);

    // A second failing chunk in the same session must NOT reload again —
    // otherwise a chunk that genuinely cannot load reloads the page forever.
    // Instead the error reaches the boundary, which is the recovery path.
    const Second = lazyWithRetry(async () => {
      throw chunkError();
    });
    const text = await renderLazyExpectingThrow(Second, 4);

    expect(reload).toHaveBeenCalledTimes(1);
    // The point of the whole change: the user sees a recovery panel, not a
    // blank page.
    expect(text).toContain("errors.ui.loadFailed");
  });

  it("does not reload for a non-chunk error, which a reload cannot fix", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    // A syntax/runtime error inside the chunk is deterministic: re-running it
    // reloads nothing useful, so this goes to the error boundary instead.
    const Broken = lazyWithRetry(async () => {
      throw new SyntaxError("Unexpected token");
    });
    const text = await renderLazyExpectingThrow(Broken, 4);

    expect(reload).not.toHaveBeenCalled();
    // It is not a chunk-load failure, so re-rendering might genuinely help —
    // the boundary must therefore still offer the retry action.
    expect(text).toContain("errors.ui.loadFailed");
    expect(text).toContain("errors.ui.tryAgain");
  });

  it("re-arms recovery after a later success, instead of staying disarmed", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    // A failure sets the guard.
    const First = lazyWithRetry(async () => {
      throw chunkError();
    });
    await renderLazy(First, 4);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("asspp:chunk-reload")).toBe("1");

    // Any chunk that then loads proves the build is fine, so the guard must be
    // cleared — otherwise one unlucky failure would disable automatic recovery
    // for the rest of the tab's life.
    const Fine = lazyWithRetry(async () => ({
      default: () => <p>healthy again</p>,
    }));
    await renderLazy(Fine, 1);
    expect(screen.getByText("healthy again")).toBeTruthy();
    expect(window.sessionStorage.getItem("asspp:chunk-reload")).toBeNull();

    // So the next genuine chunk failure gets its reload.
    const Second = lazyWithRetry(async () => {
      throw chunkError();
    });
    await renderLazy(Second, 4);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload for an ordinary fetch() failure", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    // The wording an app-level fetch rejection carries — `appleRequest` throws
    // exactly this when Apple cannot be reached. Reloading the page because a
    // request to Apple failed would discard in-flight downloads for nothing.
    const AppleUnreachable = lazyWithRetry(async () => {
      throw new TypeError("Failed to fetch");
    });
    const text = await renderLazyExpectingThrow(AppleUnreachable, 4);

    expect(reload).not.toHaveBeenCalled();
    expect(text).toContain("errors.ui.loadFailed");
  });
});

describe("lazyWithRetry rendering errors", () => {
  it("propagates a component's own render error to the caller", async () => {
    // Sanity check that the harness above detects thrown errors at all;
    // otherwise "expect(reload).not.toHaveBeenCalled()" would pass vacuously.
    const Bad = lazyWithRetry(async () => ({ default: Boom }));
    await expect(renderLazy(Bad, 1)).rejects.toThrow("render exploded");
  });
});
