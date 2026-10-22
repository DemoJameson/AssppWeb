import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Account } from "../../src/types";

const mocks = vi.hoisted(() => ({
  forgetDownloadKBSync: vi.fn(),
}));

vi.mock("../../src/apple/sap/kbsyncCache", () => ({
  forgetDownloadKBSync: mocks.forgetDownloadKBSync,
}));

import { useAccountsStore } from "../../src/store/accounts";

const mockAccount: Account = {
  email: "test@example.com",
  password: "secret",
  appleId: "test@example.com",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token123",
  directoryServicesIdentifier: "dsid123",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

describe("store/accounts", () => {
  beforeEach(async () => {
    mocks.forgetDownloadKBSync.mockReset();
    // Clear the store
    const state = useAccountsStore.getState();
    for (const account of state.accounts) {
      await state.removeAccount(account.email);
    }
    await state.loadAccounts();
  });

  it("should start with empty accounts", async () => {
    await useAccountsStore.getState().loadAccounts();
    expect(useAccountsStore.getState().accounts).toHaveLength(0);
  });

  it("should add an account", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    const accounts = useAccountsStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("test@example.com");
    expect(accounts[0].firstName).toBe("Test");
  });

  it("should persist account to IndexedDB and reload", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().loadAccounts();
    const accounts = useAccountsStore.getState().accounts;
    expect(accounts.find((a) => a.email === "test@example.com")).toBeDefined();
  });

  it("should remove an account", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    expect(useAccountsStore.getState().accounts).toHaveLength(1);

    await useAccountsStore.getState().removeAccount("test@example.com");
    expect(useAccountsStore.getState().accounts).toHaveLength(0);
  });

  it("should forget the account's cached kbsync on removal", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().removeAccount("test@example.com");

    expect(mocks.forgetDownloadKBSync).toHaveBeenCalledWith(
      "aabbccddeeff",
      "dsid123",
    );
  });

  it("should still remove an account when kbsync cleanup fails", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    mocks.forgetDownloadKBSync.mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      useAccountsStore.getState().removeAccount("test@example.com"),
    ).resolves.toBeUndefined();

    expect(useAccountsStore.getState().accounts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[accounts] failed to clear cached kbsync",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("should update an account", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);

    const updated = {
      ...mockAccount,
      firstName: "Updated",
      passwordToken: "newtoken",
    };
    await useAccountsStore.getState().updateAccount(updated);

    const accounts = useAccountsStore.getState().accounts;
    expect(accounts[0].firstName).toBe("Updated");
    expect(accounts[0].passwordToken).toBe("newtoken");
  });

  it("should handle multiple accounts", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().addAccount({
      ...mockAccount,
      email: "other@example.com",
      firstName: "Other",
    });

    expect(useAccountsStore.getState().accounts).toHaveLength(2);
  });

  it("should replace account with same email on add", async () => {
    await useAccountsStore.getState().addAccount(mockAccount);
    await useAccountsStore.getState().addAccount({
      ...mockAccount,
      firstName: "Replaced",
    });

    const accounts = useAccountsStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].firstName).toBe("Replaced");
  });
});
