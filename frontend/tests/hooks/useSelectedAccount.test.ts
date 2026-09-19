import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSelectedAccount } from "../../src/hooks/useSelectedAccount";
import type { Account } from "../../src/types";

function account(email: string): Account {
  return {
    email,
    password: "secret",
    appleId: email,
    store: "143441",
    firstName: "Test",
    lastName: "User",
    passwordToken: "token",
    directoryServicesIdentifier: email,
    cookies: [],
    deviceIdentifier: "aabbccddeeff",
  };
}

const accounts = [
  account("a@example.test"),
  account("b@example.test"),
  account("c@example.test"),
];

describe("useSelectedAccount", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to the first account", () => {
    const { result } = renderHook(() => useSelectedAccount(accounts));

    expect(result.current.selectedAccount).toBe("a@example.test");
  });

  it("keeps an explicit choice for the page", () => {
    const { result } = renderHook(() => useSelectedAccount(accounts));

    act(() => {
      result.current.selectAccount("c@example.test");
    });

    expect(result.current.selectedAccount).toBe("c@example.test");
  });

  it("clears the selection when the account list empties", () => {
    const { result, rerender } = renderHook(
      ({ list }: { list: Account[] }) => useSelectedAccount(list),
      { initialProps: { list: accounts } },
    );
    expect(result.current.selectedAccount).toBe("a@example.test");

    rerender({ list: [] });
    expect(result.current.selectedAccount).toBe("");
  });
});
