import { describe, expect, it } from "vitest";
import {
  clearAnisetteState,
  getAnisetteState,
  setAnisetteState,
} from "../../src/apple/anisetteStore";
import { runAnisetteTask } from "../../src/apple/anisette";

describe("apple/anisetteStore", () => {
  it("round-trips a provisioning state", async () => {
    await setAnisetteState("aabbccddee10", "state-1");
    expect(await getAnisetteState("aabbccddee10")).toBe("state-1");

    await setAnisetteState("aabbccddee10", "state-2");
    expect(await getAnisetteState("aabbccddee10")).toBe("state-2");
  });

  it("clears one device without touching another", async () => {
    await setAnisetteState("aabbccddee11", "state-a");
    await setAnisetteState("aabbccddee12", "state-b");

    await clearAnisetteState("aabbccddee11");

    expect(await getAnisetteState("aabbccddee11")).toBeUndefined();
    expect(await getAnisetteState("aabbccddee12")).toBe("state-b");
  });

  it("returns undefined for an unknown or empty device", async () => {
    expect(await getAnisetteState("aabbccddee13")).toBeUndefined();
    expect(await getAnisetteState("")).toBeUndefined();
  });

  it("serializes proof tasks for one device", async () => {
    const order: number[] = [];
    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const first = runAnisetteTask("aabbccddee14", async () => {
      order.push(1);
      await delay(10);
      order.push(2);
    });
    const second = runAnisetteTask("aabbccddee14", async () => {
      order.push(3);
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });
});
