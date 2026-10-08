// The Apple flows' error types, kept apart from `downloadProduct` — the module
// that raises them — so code that only *classifies* an error can import them
// without pulling in the libcurl-backed/WASM request graph.

import {
  FAILURE_DEVICE_VERIFICATION_FAILED,
  FAILURE_LICENSE_ALREADY_EXISTS,
  FAILURE_LICENSE_NOT_FOUND,
  FAILURE_PASSWORD_TOKEN_EXPIRED,
  FAILURE_SIGN_IN_REQUIRED,
} from "./config";

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/** The request produced no answer from Apple: the tunnel stalled, the timeout
 * passed, or the connection died before anything came back. Repeatable only when
 * nothing of Apple's own was seen — `delivered` is true once the response had
 * started, so repeating could duplicate Apple's work (read by `apple/retry.ts`).
 */
export class AppleUnreachableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    /** True when Apple's response had started before the failure. */
    public readonly delivered: boolean = false,
  ) {
    super(message);
    this.name = "AppleUnreachableError";
  }
}

/** Apple answered with something that is not a plist — an HTML error page or an
 * empty status. Mirrors ipatool's `UnexpectedResponseError`; `snippet` lets the
 * redownload recovery path tell an empty HTTP 500 apart from a real failure.
 */
export class UnexpectedAppleResponseError extends Error {
  constructor(
    readonly status: number,
    readonly snippet: string,
  ) {
    super(
      `unexpected response from Apple (HTTP ${status}): ${
        snippet || "empty or non-plist body"
      }`,
    );
    this.name = "UnexpectedAppleResponseError";
  }
}

/** Apple's version exchange answered with nothing about the app — no product, no
 * failure type — the shape an App ID both the storefront and the account's
 * purchase history disown. Only "Apple has nothing to serve for this id" raises
 * it; a failure-type reply or an unpinnable version is not (see
 * {@link appPresenceFromProbeError}).
 */
export class MissingAppError extends DownloadError {}

/** No build of the *requested platform* could be named — its catalogue/storefront
 * has no offer, no past download recorded an id, and the neighbour guess found
 * nothing. Deliberately not {@link MissingAppError} (the app may exist on other
 * platforms); carrying no failure type, {@link appPresenceFromProbeError} keeps
 * the record inconclusive rather than dropping the app.
 */
export class PlatformVersionUnavailableError extends DownloadError {
  constructor(message: string) {
    super(message);
    this.name = "PlatformVersionUnavailableError";
  }
}

/** True when the exchange could name no build for the platform asked for. */
export function isPlatformVersionUnavailable(error: unknown): boolean {
  return error instanceof PlatformVersionUnavailableError;
}

/** True when Apple's version exchange said no app answers to that id. */
export function isMissingAppError(error: unknown): boolean {
  return error instanceof MissingAppError;
}

/**
 * Failure types that leave an App ID's existence open: Apple either wants a
 * fresh session, cannot serve this account, or is temporarily unwilling to serve
 * the item — none of which is about whether the app exists.
 */
const OPEN_ENDED_FAILURE_TYPES: ReadonlySet<string> = new Set([
  FAILURE_PASSWORD_TOKEN_EXPIRED,
  FAILURE_SIGN_IN_REQUIRED,
  FAILURE_DEVICE_VERIFICATION_FAILED,
  FAILURE_LICENSE_NOT_FOUND, // no license yet: the license step decides, not this
  FAILURE_LICENSE_ALREADY_EXISTS, // already owned: it answers the purchase, not the app
  "2019", // "already purchased" — the purchase flow's synonym for the above
  "2001", // account temporarily unavailable in the iTunes Store
  "2059", // item temporarily unavailable (Apple Arcade's wording)
  "-128", // legacy "Account Not In This Store" — a storefront/account mismatch
]);

export type AppPresence =
  /** Apple has nothing to serve for this id, so it is not an app for this account. */
  | "missing"
  /** The failure was about the session or the transport — it says nothing about the app. */
  | "inconclusive";

/** Reads a failed *version exchange* for an App ID no catalogue knows. `missing` means the account
 * cannot fetch it — not "never existed", since a removed app and a made-up id fail alike — which
 * callers act on; `inconclusive` keeps a broken session or blocked host from reading as "no such app".
 * An unrecognized code defaults to `missing` (Apple's answer about this very request; a forward-compat
 * bet the tests pin), so `5002`/`2019` must sit in {@link OPEN_ENDED_FAILURE_TYPES}, never fall through.
 */
export function appPresenceFromProbeError(error: unknown): AppPresence {
  if (error instanceof MissingAppError) return "missing";

  const code = failureCodeOf(error);
  if (code === undefined) return "inconclusive";
  return OPEN_ENDED_FAILURE_TYPES.has(code) ? "inconclusive" : "missing";
}

/** The failureType Apple answered with, from any of the flow's error types. */
function failureCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}
