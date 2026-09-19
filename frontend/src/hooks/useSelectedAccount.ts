import { useEffect, useState } from "react";
import type { Account } from "../types";

/**
 * Account selection shared by the pages that pick one. The choice lives for
 * the page: entering a view falls back to the first available account, and
 * the search page's region selection brings the matching account along on
 * the detail view (see ProductDetail).
 */
export function useSelectedAccount(accounts: Account[]) {
  const [selectedAccount, setSelectedAccount] = useState("");

  useEffect(() => {
    if (accounts.length === 0) {
      if (selectedAccount !== "") setSelectedAccount("");
      return;
    }
    if (accounts.some((a) => a.email === selectedAccount)) return;
    setSelectedAccount(accounts[0].email);
  }, [accounts, selectedAccount]);

  /** Picks an account for this page. */
  function selectAccount(email: string) {
    setSelectedAccount(email);
  }

  return { selectedAccount, selectAccount };
}
