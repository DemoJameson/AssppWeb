import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountsStore } from "../../src/store/accounts";
import { useAnisetteWarmup } from "../../src/hooks/useAnisetteWarmup";
import type { Account } from "../../src/types";

const mocks = vi.hoisted(() => ({
  prepareAnisette: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/apple/anisette", () => ({
  prepareAnisette: mocks.prepareAnisette,
}));

const account = {
  email: "test@example.com",
  deviceIdentifier: "aabbccddeeff",
} as Account;

beforeEach(() => {
  useAccountsStore.setState({ accounts: [], loading: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAnisetteWarmup", () => {
  it("prepares the helper once an account exists, once per page session", async () => {
    renderHook(() => useAnisetteWarmup());
    expect(mocks.prepareAnisette).not.toHaveBeenCalled();

    act(() => {
      useAccountsStore.setState({ accounts: [account], loading: false });
    });
    await waitFor(() =>
      expect(mocks.prepareAnisette).toHaveBeenCalledTimes(1),
    );

    act(() => {
      useAccountsStore.setState({ accounts: [account, account] });
    });
    expect(mocks.prepareAnisette).toHaveBeenCalledTimes(1);
  });
});
