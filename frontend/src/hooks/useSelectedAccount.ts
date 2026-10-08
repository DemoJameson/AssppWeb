import { useEffect, useState } from "react";
import type { Account } from "../types";

/**
 * Account selection shared by the pages that pick one — page-lifetime, falling
 * back to the first available account or to `preferredEmail` when the caller
 * carries one (e.g. the package detail's 「应用详情」 hop; see ProductDetail).
 */
export function useSelectedAccount(
  accounts: Account[],
  preferredEmail?: string,
) {
  const [selectedAccount, setSelectedAccount] = useState("");

  useEffect(() => {
    if (accounts.length === 0) {
      if (selectedAccount !== "") setSelectedAccount("");
      return;
    }
    if (accounts.some((a) => a.email === selectedAccount)) return;
    if (preferredEmail && accounts.some((a) => a.email === preferredEmail)) {
      setSelectedAccount(preferredEmail);
      return;
    }
    setSelectedAccount(accounts[0].email);
  }, [accounts, selectedAccount, preferredEmail]);

  /** Picks an account for this page. */
  function selectAccount(email: string) {
    setSelectedAccount(email);
  }

  return { selectedAccount, selectAccount };
}
