import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSelectedAccount } from "../../src/hooks/useSelectedAccount";
import { useSettingsStore } from "../../src/store/settings";
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
    useSettingsStore.setState({ defaultAccount: "" });
  });

  it("falls back to the first account when nothing is remembered", () => {
    const { result } = renderHook(() => useSelectedAccount(accounts));

    expect(result.current.selectedAccount).toBe("a@example.test");
    // Automatic fallback is not persisted — only explicit choices are.
    expect(useSettingsStore.getState().defaultAccount).toBe("");
  });

  it("reuses the remembered account while it is available", () => {
    useSettingsStore.setState({ defaultAccount: "b@example.test" });

    const { result } = renderHook(() => useSelectedAccount(accounts));

    expect(result.current.selectedAccount).toBe("b@example.test");
  });

  it("falls back to the first account when the remembered one is gone", () => {
    useSettingsStore.setState({ defaultAccount: "gone@example.test" });

    const { result } = renderHook(() => useSelectedAccount(accounts));

    expect(result.current.selectedAccount).toBe("a@example.test");
  });

  it("remembers an explicit choice", () => {
    const { result } = renderHook(() => useSelectedAccount(accounts));

    act(() => {
      result.current.selectAccount("c@example.test");
    });

    expect(result.current.selectedAccount).toBe("c@example.test");
    expect(useSettingsStore.getState().defaultAccount).toBe("c@example.test");
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
