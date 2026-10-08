// Repeating an Apple call that never produced an answer. A stalled path is usually per-connection, not a
// dead host (the storefront host's pool leaves some connections silent past 20s; see AGENTS.md), so
// `appleRequest` raises `AppleUnreachableError` and repeating lands on a fresh connection. An answered
// call is never repeated — a refusal, missing license or expired token is an answer — nor one whose response
// was lost to Apple acting: also `AppleUnreachableError`, but `delivered` true, so the license grant repeats safely.

import { AppleUnreachableError } from "./errors";

/**
 * Runs `call`, repeating it while it fails without an answer (at most `attempts`
 * times); anything Apple answered — or whose response had already started — is rethrown.
 */
export async function repeatUnreachable<T>(
  call: () => Promise<T>,
  attempts: number = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const repeatable =
        error instanceof AppleUnreachableError && !error.delivered;
      if (attempt >= attempts || !repeatable) {
        throw error;
      }
    }
  }
}
