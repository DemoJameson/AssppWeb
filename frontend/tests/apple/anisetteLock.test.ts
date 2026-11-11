import { afterEach, describe, expect, it, vi } from "vitest";

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

class FakeLockManager {
  private readonly tails = new Map<string, Promise<unknown>>();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(callback);
    this.tails.set(name, current);
    return current;
  }
}

afterEach(() => {
  if (originalLocks) {
    Object.defineProperty(navigator, "locks", originalLocks);
  } else {
    delete (navigator as { locks?: unknown }).locks;
  }
  vi.resetModules();
});

describe("anisette cross-tab lock", () => {
  it("serializes tasks from separate module instances", async () => {
    const locks = new FakeLockManager();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });

    // Separate module instances model separate tabs: each has its own
    // module-level state queue, while both share IndexedDB and Web Locks.
    vi.resetModules();
    const first = await import("../../src/apple/anisette");
    vi.resetModules();
    const second = await import("../../src/apple/anisette");

    const order: string[] = [];
    const delay = (milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds));

    const a = first.runAnisetteTask("aabbccddeeff", async () => {
      order.push("a-start");
      await delay(10);
      order.push("a-end");
    });
    const b = second.runAnisetteTask("aabbccddeeff", async () => {
      order.push("b-start");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });
});
