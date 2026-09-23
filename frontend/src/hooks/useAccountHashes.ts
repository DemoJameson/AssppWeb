import { useEffect, useState } from "react";
import { accountHash } from "../utils/account";
import type { Account } from "../types";

/**
 * The download list's own key for each account, by email. A package is filed
 * under the digest of the account that fetched it, so everything that asks what
 * one account already holds needs that account's hash — and the digest is only
 * ever agreed asynchronously (`utils/account.accountHash`).
 *
 * Empty until the digests are ready; an account the map does not name holds
 * nothing yet (see `utils/downloaded`).
 */
export function useAccountHashes(accounts: Account[]): Record<string, string> {
  const [byEmail, setByEmail] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pairs = await Promise.all(
        accounts.map(
          async (account) => [account.email, await accountHash(account)] as const,
        ),
      );
      if (cancelled) return;
      setByEmail(Object.fromEntries(pairs));
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  return byEmail;
}
