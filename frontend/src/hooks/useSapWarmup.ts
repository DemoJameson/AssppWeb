import { useEffect } from "react";
import { useAccountsStore } from "../store/accounts";
import { useSapStore } from "../store/sap";
import { fetchBag } from "../apple/bag";

// Warms up the SAP signer in the background once an account exists: preparation
// is dominated by a one-time ~14 MB asset download (Cache API makes later runs
// instant), so starting on load usually finds it ready. It waits for an account
// because the signer binds to that hardware id. Fire and forget — the store
// carries the outcome, and failures surface only when a signature is needed.
export function useSapWarmup() {
  const accounts = useAccountsStore((state) => state.accounts);
  const stage = useSapStore((state) => state.stage);

  useEffect(() => {
    if (stage !== "idle") {
      return;
    }

    const device = accounts.find(
      (account) => account.deviceIdentifier,
    )?.deviceIdentifier;
    if (!device) {
      return;
    }

    fetchBag(device)
      .then(async (bag) => {
        if (!bag.sapEndpoints) {
          return; // bag without SAP keys: legacy flow, nothing to warm up
        }
        // On-demand import keeps the SAP machinery out of the route's initial download.
        const { prepareSigner } = await import("../apple/sap/client");
        await prepareSigner(device, bag.sapEndpoints);
      })
      .catch(() => {
        // warmup is best-effort; sign-in will retry and surface real errors
      });
  }, [accounts, stage]);
}
