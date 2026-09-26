// Repeating an Apple call that never produced an answer.
//
// A stalled path is usually a per-connection accident rather than a dead host:
// measured from one network, the storefront host's address pool answered some
// connections in ~130 ms and left others silent past 20 seconds (see AGENTS.md).
// `appleRequest` fails those with `AppleUnreachableError`, so repeating the call
// lands on a fresh connection with a good chance of working.
//
// A call Apple *answered* is never repeated here. A refusal, a missing license
// or an expired token is an answer, and the caller decides with it. Neither is a
// call whose *response* was lost while being read: that error is
// `AppleUnreachableError` too, since nothing usable came back, but Apple has
// already acted on the request — repeating it could duplicate what it did. The
// type's `delivered` flag is that distinction, and it is why a request with a
// side effect (the license grant) can be repeated safely at all.

import { AppleUnreachableError } from "./errors";

/**
 * Runs `call`, repeating it while it fails without an answer, at most
 * `attempts` times. Anything Apple answered — or any other error, including one
 * whose response had already started — is rethrown as it is.
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
