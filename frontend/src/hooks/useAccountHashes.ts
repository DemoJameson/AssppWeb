import { useEffect, useState } from "react";
import { accountHash } from "../utils/account";
import type { Account } from "../types";

/**
 * The download list's own key for each account, by email. A package is filed
 * under the account's digest, which is only agreed asynchronously
 * (`utils/account.accountHash`). Empty until the digests are ready; an account
 * the map does not name holds nothing yet (see `utils/downloaded`).
 */
/** Whether two digest maps name the same accounts with the same digests. */
function sameHashes(
  previous: Record<string, string>,
  next: Record<string, string>,
): boolean {
  const emails = Object.keys(next);
  return (
    emails.length === Object.keys(previous).length &&
    emails.every((email) => previous[email] === next[email])
  );
}

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
      // Same digests make the same map: the account store hands over a new array
      // on every cookie write-back (once per build during a version fill), and a
      // new map would re-render the page for nothing (see AGENTS.md).
      const next = Object.fromEntries(pairs);
      setByEmail((previous) => (sameHashes(previous, next) ? previous : next));
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  return byEmail;
}
