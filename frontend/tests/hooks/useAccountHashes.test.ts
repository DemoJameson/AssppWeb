import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAccountHashes } from "../../src/hooks/useAccountHashes";
import type { Account } from "../../src/types";

// The digest is the account's identity, so the stub has to follow it.
vi.mock("../../src/utils/account", () => ({
  accountHash: async (account: Account) =>
    `hash-${account.email}-${account.directoryServicesIdentifier}`,
}));

const account: Account = {
  email: "dev@example.test",
  password: "secret",
  appleId: "dev@example.test",
  store: "143441",
  firstName: "Dev",
  lastName: "Tester",
  passwordToken: "token",
  directoryServicesIdentifier: "123456789",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

/** The digest map the hook agreed to, as a plain record. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("useAccountHashes", () => {
  it("maps every account to its digest key", async () => {
    const { result } = renderHook(() => useAccountHashes([account]));
    await settle();

    expect(result.current).toEqual({
      [account.email]: `hash-${account.email}-${account.directoryServicesIdentifier}`,
    });
  });

  it("keeps the same map when a fresh array carries the same accounts", async () => {
    // The account store hands over a new array every time a session writes its
    // cookies back. Refreshing the map then would re-render the page for
    // nothing — the page is the one that wrote the cookies.
    const { result, rerender } = renderHook(
      ({ accounts }: { accounts: Account[] }) => useAccountHashes(accounts),
      { initialProps: { accounts: [account] } },
    );
    await settle();
    const agreed = result.current;

    rerender({ accounts: [{ ...account, cookies: [] }] });
    await settle();

    expect(result.current).toBe(agreed);
  });

  it("re-maps when a digest actually changes", async () => {
    const { result, rerender } = renderHook(
      ({ accounts }: { accounts: Account[] }) => useAccountHashes(accounts),
      { initialProps: { accounts: [account] } },
    );
    await settle();

    rerender({
      accounts: [{ ...account, directoryServicesIdentifier: "987654321" }],
    });
    await settle();

    expect(result.current[account.email]).toBe(
      `hash-${account.email}-987654321`,
    );
  });

  it("drops the account that is gone", async () => {
    const other: Account = {
      ...account,
      email: "other@example.test",
      directoryServicesIdentifier: "555",
    };
    const { result, rerender } = renderHook(
      ({ accounts }: { accounts: Account[] }) => useAccountHashes(accounts),
      { initialProps: { accounts: [account, other] } },
    );
    await settle();
    expect(Object.keys(result.current)).toHaveLength(2);

    rerender({ accounts: [other] });
    await settle();

    expect(result.current).toEqual({
      [other.email]: `hash-${other.email}-555`,
    });
  });
});
