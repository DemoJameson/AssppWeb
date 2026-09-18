import { useEffect, useState } from "react";
import { useSettingsStore } from "../store/settings";
import type { Account } from "../types";

/**
 * Account selection shared by the pages that pick one. The last explicit
 * choice is remembered in the settings store (persisted), so every selector
 * reuses it while the account is still present and falls back to the first
 * available account otherwise.
 */
export function useSelectedAccount(accounts: Account[]) {
  const defaultAccount = useSettingsStore((s) => s.defaultAccount);
  const setDefaultAccount = useSettingsStore((s) => s.setDefaultAccount);
  const [selectedAccount, setSelectedAccount] = useState("");

  useEffect(() => {
    if (accounts.length === 0) {
      if (selectedAccount !== "") setSelectedAccount("");
      return;
    }
    if (accounts.some((a) => a.email === selectedAccount)) return;

    const preferred = accounts.find((a) => a.email === defaultAccount);
    setSelectedAccount(preferred ? preferred.email : accounts[0].email);
  }, [accounts, selectedAccount, defaultAccount]);

  /** Picks an account for this page and remembers it for the next visit. */
  function selectAccount(email: string) {
    setSelectedAccount(email);
    setDefaultAccount(email);
  }

  return { selectedAccount, selectAccount };
}
