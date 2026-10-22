import { create } from "zustand";
import { openDB, type IDBPDatabase } from "idb";
import type { Account } from "../types";
import { forgetDownloadKBSync } from "../apple/sap/kbsyncCache";

const DB_NAME = "asspp-accounts";
const STORE_NAME = "accounts";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "email" });
        }
      },
    });
  }
  return dbPromise;
}

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  loadAccounts: () => Promise<void>;
  addAccount: (account: Account) => Promise<void>;
  removeAccount: (email: string) => Promise<void>;
  updateAccount: (account: Account) => Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: true,

  loadAccounts: async () => {
    set({ loading: true });
    const db = await getDB();
    const accounts = await db.getAll(STORE_NAME);
    set({ accounts, loading: false });
  },

  addAccount: async (account: Account) => {
    const db = await getDB();
    await db.put(STORE_NAME, account);
    set({
      accounts: [
        ...get().accounts.filter((a) => a.email !== account.email),
        account,
      ],
    });
  },

  removeAccount: async (email: string) => {
    const account = get().accounts.find((candidate) => candidate.email === email);
    const db = await getDB();
    await db.delete(STORE_NAME, email);
    set({ accounts: get().accounts.filter((a) => a.email !== email) });

    // Cache cleanup is best-effort: account deletion has already committed, so
    // a cache failure must not make the UI report a failed delete.
    if (account?.deviceIdentifier && account.directoryServicesIdentifier) {
      try {
        forgetDownloadKBSync(
          account.deviceIdentifier,
          account.directoryServicesIdentifier,
        );
      } catch (error) {
        console.warn("[accounts] failed to clear cached kbsync", error);
      }
    }
  },

  updateAccount: async (account: Account) => {
    const db = await getDB();
    await db.put(STORE_NAME, account);
    set({
      accounts: get().accounts.map((a) =>
        a.email === account.email ? account : a,
      ),
    });
  },
}));

// Auto-load accounts on import
useAccountsStore.getState().loadAccounts();
