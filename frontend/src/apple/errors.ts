// The Apple flows' error types, kept in a module of their own.
//
// They live apart from `downloadProduct` — the module that raises them — so that
// code which only needs to *classify* an error can import them without pulling
// in the libcurl-backed request graph: a component deciding whether an App ID
// names a real app must stay loadable in environments without the WASM client.

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

/**
 * The request never produced an answer from Apple: the tunnel stalled, the
 * request outlived its timeout, or the connection died before anything came
 * back. Nothing is known about the request itself, so a caller may repeat it —
 * on Apple's other endpoint, say — which is exactly what it may *not* do with an
 * error Apple answered with (a refused sign-in comes back as a response).
 *
 * The message is meant for the user; `cause` keeps whatever the transport said.
 */
export class AppleUnreachableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppleUnreachableError";
  }
}

/**
 * Apple answered with something that is not a plist — an HTML error page, or a
 * status with nothing in it. Mirrors ipatool's `UnexpectedResponseError`; the
 * `snippet` is what the redownload recovery path inspects to tell an empty HTTP
 * 500 apart from a real failure.
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

/**
 * Apple's version exchange answered with nothing about the app: no product and
 * no failure type. That is the shape an App ID the storefront and the account's
 * purchase history both disown comes back as, so a caller may read it as "there
 * is no such app" rather than as a failure to retry.
 *
 * A reply carrying a failure type is *not* this: Apple recognised the request
 * and declined it for its own reason (a stale session, no license, an app it
 * will not serve), which says nothing about whether the app exists. Those stay
 * plain `DownloadError`s.
 *
 * Every site in the version exchange that means "Apple has nothing to serve for
 * this App ID" — an item-less reply, or Apple's own availability wording —
 * raises this type, and only those sites. Callers then get their answer from
 * {@link appPresenceFromProbeError} instead of from message matching.
 *
 * A version that cannot be pinned is deliberately NOT one of them: it only
 * means no build could be named yet, and a known version id can still serve a
 * delisted app, so callers keep such ids usable.
 */
export class MissingAppError extends DownloadError {}

/**
 * No build of the *requested platform* could be named: the platform's own
 * catalogue or storefront page has no offer, no past download recorded a
 * version id for it, and the neighbour guess found nothing either.
 *
 * This is deliberately not {@link MissingAppError}: the app may well exist on
 * other platforms (a package on this instance is proof of that), and a version
 * id could still serve it. What it settles is narrower — this platform has
 * nothing to fetch — which is why callers may read it as "不可下载 here"
 * rather than as an open question. It carries no failure type, so
 * {@link appPresenceFromProbeError} keeps the record (inconclusive) instead of
 * dropping the app.
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
 * fresh session, cannot serve this account at all, or is temporarily unwilling
 * to serve the item — none of which is about whether the app exists.
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

/**
 * Reads a failed *version exchange* for an App ID no catalogue knows — the one
 * question the storefront and the local package index could not answer.
 *
 * `missing` is not "this id never existed in Apple's catalogue": Apple does not
 * tell us that, and the reasons a disowned id fails (a product it will not sell,
 * a purchase it will not complete, an empty receipt) are the same for a removed
 * app and for a made-up number. It says the account cannot fetch anything for
 * it, which is what the caller has to act on.
 *
 * `inconclusive` exists so a broken session or a blocked host is never dressed
 * up as "no such app": those failures must leave the id usable.
 *
 * The default for an *unrecognized* code is "missing", not "inconclusive":
 * these codes are Apple's answer about this very request, so an unknown one is
 * far more likely a refusal than a transport fault. That is a deliberate
 * forward-compatibility bet — if Apple ever introduces a code that really
 * means "session expired", bare cards would be dropped until the set above
 * learns it. Tests pin this default; revisit it there when the set grows.
 *
 * A code whose meaning is already known must therefore never fall through to
 * that default. `5002`/`2019` (already owned) are the case that made this
 * explicit: both are purchase outcomes, not "no such app", so they belong in
 * {@link OPEN_ENDED_FAILURE_TYPES} above rather than being read as a miss.
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
