import { useEffect } from "react";
import { useAccountsStore } from "../store/accounts";

/**
 * Warms the backend Anisette helper once an account exists. The add-account
 * page does this while the user types, but an existing or imported account may
 * go straight to downloads; the first commerce request must not be the one that
 * pays for the helper's cold asset/Unicorn load. One attempt per page session
 * is enough; the helper's prepare is idempotent.
 */

let warmupStarted = false;

export function useAnisetteWarmup(): void {
  const hasAccount = useAccountsStore((state) => state.accounts.length > 0);

  useEffect(() => {
    if (!hasAccount || warmupStarted) return;

    warmupStarted = true;
    void import("../apple/anisette")
      .then(({ prepareAnisette }) => prepareAnisette())
      .catch(() => {
        // The helper may simply be unavailable here; the real request will
        // surface that error with its own context.
        warmupStarted = false;
      });
  }, [hasAccount]);
}
