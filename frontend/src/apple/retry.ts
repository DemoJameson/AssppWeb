// Repeating an Apple call that never produced an answer.
//
// A stalled path is usually a per-connection accident rather than a dead host:
// measured from one network, the storefront host's address pool answered some
// connections in ~130 ms and left others silent past 20 seconds (see AGENTS.md).
// `appleRequest` fails those with `AppleUnreachableError` — nothing reached
// Apple, nothing came back — so repeating the call lands on a fresh connection
// with a good chance of working, and cannot duplicate anything Apple did.
//
// A call Apple *answered* is never repeated here. A refusal, a missing license
// or an expired token is an answer, and the caller decides with it.

import { AppleUnreachableError } from "./errors";

/**
 * Runs `call`, repeating it while it fails without an answer, at most
 * `attempts` times. Anything Apple answered (or any other error) is rethrown
 * as it is.
 */
export async function repeatUnreachable<T>(
  call: () => Promise<T>,
  attempts: number = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !(error instanceof AppleUnreachableError)) {
        throw error;
      }
    }
  }
}
