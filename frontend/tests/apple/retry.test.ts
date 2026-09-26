import { describe, expect, it, vi } from "vitest";
import { repeatUnreachable } from "../../src/apple/retry";
import { AppleUnreachableError } from "../../src/apple/errors";

describe("apple/retry", () => {
  it("hands back the first answer", async () => {
    const call = vi.fn(async () => "answer");

    await expect(repeatUnreachable(call)).resolves.toBe("answer");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("repeats a call that never produced an answer", async () => {
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new AppleUnreachableError("Apple did not answer"))
      .mockResolvedValueOnce("answer");

    await expect(repeatUnreachable(call)).resolves.toBe("answer");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt", async () => {
    const call = vi.fn(async () => {
      throw new AppleUnreachableError("Apple did not answer");
    });

    await expect(repeatUnreachable(call)).rejects.toThrow(
      "Apple did not answer",
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("never repeats an answer Apple sent", async () => {
    const refusal = new Error("your password was entered incorrectly");
    const call = vi.fn(async () => {
      throw refusal;
    });

    await expect(repeatUnreachable(call)).rejects.toBe(refusal);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
