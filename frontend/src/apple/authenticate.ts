import type { Account, Cookie } from "../types";
import { appleRequest, type AppleResponse } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  fetchBag,
  defaultAuthURL,
  legacyAuthURL,
  normalizeAuthURL,
} from "./bag";
import { authStoreFront, isAppleHost, storeUserAgent } from "./config";
import { AppleUnreachableError } from "./errors";
import { prepareSigner } from "./sap/client";
import {
  fetchAuthHeaders,
  runAnisetteTask,
} from "./anisette";
import { getAnisetteState, setAnisetteState } from "./anisetteStore";
import {
  machineActionFromResponse,
  provisionMachineAction,
  stripMachineHeaders,
} from "./machineValidation";
import i18n from "../i18n";

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const AUTH_RETRY_BASE_MS = 10_000;
const AUTH_RETRY_MAX_MS = 30_000;
const AUTH_SHORT_RETRY_MS = 250;
const FAILURE_INVALID_CREDENTIALS = "-5000";

class AuthenticationRetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthenticationRetryExhaustedError";
  }
}

/**
 * Apple's first-attempt invalid-credentials answer is the one response ipatool
 * retries with `attempt=2`; every other structured answer is terminal.
 */
class AuthenticationAttemptRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationAttemptRetryError";
  }
}

/** The one place 2FA input is normalized: whitespace is ignored, but the
 * remaining value must be exactly six ASCII digits. The password is untouched.
 */
export function sanitizeAuthCodeInput(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 6);
}

function normalizeAuthCode(code?: string): string | undefined {
  if (code === undefined || code === "") return undefined;

  const normalized = code.replace(/\s/gu, "");
  if (!/^[0-9]{6}$/.test(normalized)) {
    throw new AuthenticationError(i18n.t("errors.auth.invalidCode"));
  }

  return normalized;
}

export async function authenticate(
  appleId: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
): Promise<Account> {
  const normalizedCode = normalizeAuthCode(code);
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let fullStoreFront = "";
  let lastError: Error | null = null;

  // Sign-in goes to the endpoint the bag advertises; fetchBag falls back to
  // Apple's native endpoint, so there is always one to call. The native endpoint
  // is preferred; the legacy storefront endpoint is the alternate when native
  // is unreachable or keeps answering 204/404 without an SP action.
  const bag = await fetchBag(deviceId);
  const guid = deviceId.toUpperCase();
  const bagEndpoint = new URL(bag.authURL);
  const primaryEndpoint = bagEndpoint;
  if (primaryEndpoint.hostname !== "auth.itunes.apple.com") {
    primaryEndpoint.searchParams.set("guid", guid);
  }
  let requestHost = primaryEndpoint.hostname;
  let requestPath = `${primaryEndpoint.pathname}${primaryEndpoint.search}`;

  // Apple answers sign-ins on two equivalent endpoints (storefront and native)
  // that do not fail together, so a request that never reached Apple is retried
  // on the other before the sign-in is called off.
  const altAuthEndpoint = new URL(
    bagEndpoint.hostname === "auth.itunes.apple.com"
      ? legacyAuthURL
      : defaultAuthURL,
  );
  if (altAuthEndpoint.hostname !== "auth.itunes.apple.com") {
    altAuthEndpoint.searchParams.set("guid", guid);
  }
  let triedAltEndpoint =
    altAuthEndpoint.hostname === primaryEndpoint.hostname &&
    altAuthEndpoint.pathname === primaryEndpoint.pathname;

  // When the bag advertises SAP signing, every auth request must carry
  // X-Apple-ActionSignature over its body. The signer sees only the hardware ID
  // and public assets — never the password. Singleton so 2FA retries reuse it.
  let sapSigner = null as Awaited<ReturnType<typeof prepareSigner>> | null;
  let anisetteHeaders: Record<string, string> = {};
  let anisetteAvailable = true;
  let machineHeadersSuppressed = false;

  // The proof is minted for the URL the request will actually use. A pod
  // redirect or endpoint failover changes that URL, so the headers are
  // refreshed for the new target instead of reusing a proof for the old one.
  async function prepareAnisetteHeaders(): Promise<void> {
    const result = await runAnisetteTask(deviceId, async () => {
      const state = await getAnisetteState(deviceId);
      const result = await fetchAuthHeaders(
        deviceId,
        state,
        `https://${requestHost}${requestPath}`,
      );
      await setAnisetteState(deviceId, result.state);
      return result;
    });

    // Keep the identity headers already on the request and replace only the
    // machine-validation set. Apple may answer in either family.
    anisetteHeaders = {
      ...stripMachineHeaders(anisetteHeaders),
      ...result.headers,
    };
    anisetteAvailable = true;
  }

  function disableAnisette(error: unknown): void {
    anisetteAvailable = false;
    anisetteHeaders = stripMachineHeaders(anisetteHeaders);
    console.warn(
      `[anisette] machine validation unavailable; trying SAP-only sign-in: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  async function refreshAnisetteHeaders(): Promise<void> {
    if (!anisetteAvailable || machineHeadersSuppressed) return;
    try {
      await prepareAnisetteHeaders();
    } catch (error) {
      disableAnisette(error);
    }
  }

  // The SAP signer and Anisette helper are independent; starting both now keeps
  // the first-run asset preparation off the critical path.
  const signerPromise = bag.sapEndpoints
    ? prepareSigner(deviceId, bag.sapEndpoints)
    : Promise.resolve(null);
  const anisettePromise = prepareAnisetteHeaders().catch(disableAnisette);

  [sapSigner] = await Promise.all([signerPromise, anisettePromise]);

  let currentAttempt = 0;
  let redirectAttempt = 0;
  let actionAttempt = 0;
  let loginAttempt = normalizedCode ? 2 : 1;

  while (
    currentAttempt < 2 &&
    redirectAttempt <= 3 &&
    actionAttempt <= 2
  ) {
    currentAttempt++;

    try {
      const body: Record<string, string> = {
        appleId,
        attempt: String(loginAttempt),
        guid,
        password: normalizedCode ? `${password}${normalizedCode}` : password,
        rmp: "0",
        why: "signIn",
      };

      const plistBody = buildPlist(body);

      const headers: Record<string, string> = {
        ...anisetteHeaders,
        "Content-Type": "application/x-apple-plist",
        "User-Agent": storeUserAgent,
      };

      // A phone-number Apple ID identifies no storefront, and Apple sends the
      // verification code only to a request that asks as the region's store.
      const storeFrontHeader = authStoreFront(appleId);
      if (storeFrontHeader) {
        headers["X-Apple-Store-Front"] = storeFrontHeader;
      }

      if (sapSigner) {
        // The signature must cover the exact bytes on the wire; libcurl sends
        // the body string as UTF-8, so sign its encoded form.
        headers["X-Apple-ActionSignature"] = await sapSigner.sign(
          new TextEncoder().encode(plistBody),
        );
      }

      const response = await sendAuthenticationRequest(
        {
          method: "POST",
          host: requestHost,
          path: requestPath,
          headers,
          body: plistBody,
          cookies,
        },
        anisetteAvailable,
        (retryResponse) => {
          cookies = extractAndMergeCookies(
            retryResponse.rawHeaders,
            cookies,
          );
          return cookies;
        },
      );

      // Apple's machine action takes precedence over redirects and bodies:
      // an empty 204/404 carrying X-Apple-{AMD,MD}-Action is a request to
      // reprovision, not a failed sign-in (ipatool's parseLoginResponse).
      const machineAction = machineActionFromResponse(response.headers);
      if (machineAction) {
        if (actionAttempt >= 2) {
          throw new Error(
            i18n.t("errors.auth.deviceVerificationLoop", {
              action: machineAction.action,
            }),
          );
        }
        actionAttempt++;

        if (machineAction.action === "RP") {
          machineHeadersSuppressed = true;
          // The next attempt carries only the non-machine identity headers.
          anisetteHeaders = stripMachineHeaders(anisetteHeaders);
          currentAttempt--;
          continue;
        }

        if (machineAction.action === "SP") {
          const result = await provisionMachineAction(
            deviceId,
            machineAction,
            `https://${requestHost}${requestPath}`,
            anisetteHeaders,
            bag,
          );
          // Replace the machine set with the fresh proof, keeping the
          // credential-free identity headers the request already carried.
          anisetteHeaders = {
            ...stripMachineHeaders(anisetteHeaders),
            ...(result.headers ?? {}),
          };
          machineHeadersSuppressed = false;
          currentAttempt--;
          continue;
        }

        throw new Error(
          i18n.t("errors.auth.deviceVerificationUnsupported", {
            action: machineAction.action,
          }),
        );
      }

      // Apple can answer a sign-in with a server dialog (account locked,
      // recovery, terms) before any redirect. Surface it instead of treating a
      // 3xx without Location as a generic redirect failure.
      const dialogError = response.body.trim()
        ? dialogFromResponseBody(response.body)
        : null;
      if (dialogError) throw new AuthenticationError(dialogError);

      // Read store front. Some responses carry only the request-side header.
      const storeHeader =
        response.headers["x-set-apple-store-front"] ??
        response.headers["x-apple-request-store-front"];
      if (storeHeader) {
        fullStoreFront = storeHeader.trim();
        const identifier = fullStoreFront.split(",")[0].split("-")[0];
        if (identifier) {
          storeFront = identifier;
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;

      // Handle redirect. 301/302/307/308 mean "a pod answered — replay the
      // signed POST there"; 303 is excluded because it asks for a GET
      // (ipatool's `IsAuthenticationRedirect`).
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          throw new Error(i18n.t("errors.auth.redirectLocation"));
        }
        const url = new URL(location, `https://${requestHost}`);
        // The retry carries session cookies to whatever host Location names, so
        // a hop off Apple's domains is refused rather than followed with them.
        if (!isAppleHost(url.hostname)) {
          throw new Error(i18n.t("errors.auth.redirectHost"));
        }
        // A pod hands back the same sign-in endpoint (same trailing slash), so
        // the hop goes through the normalizer too.
        const target = new URL(normalizeAuthURL(url.toString()));
        requestHost = target.hostname;
        requestPath = `${target.pathname}${target.search}`;
        currentAttempt--;
        redirectAttempt++;
        await refreshAnisetteHeaders();
        continue;
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        if (
          !anisetteAvailable &&
          (response.status === 204 || response.status === 404)
        ) {
          throw new Error(i18n.t("errors.auth.deviceVerificationUnavailable"));
        }
        throw new Error(
          i18n.t("errors.auth.emptyBody", { status: response.status }),
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      // ipatool retries a first-attempt invalid-credentials answer with
      // attempt=2; Apple uses that retry to surface the 2FA prompt.
      if (
        String(dict.failureType ?? "") === FAILURE_INVALID_CREDENTIALS &&
        loginAttempt === 1
      ) {
        loginAttempt = 2;
        throw new AuthenticationAttemptRetryError(
          String(
            (dict.dialog as Record<string, any>)?.explanation ??
              dict.customerMessage ??
              i18n.t("errors.auth.unknownReason"),
          ),
        );
      }

      // Check for 2FA requirement. Apple answers the same whether it wants a
      // code or refused one — only whether the caller supplied one differs.
      if (
        dict.failureType === "" &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        throw new AuthenticationError(
          i18n.t(
            normalizedCode
              ? "errors.auth.verificationIncomplete"
              : "errors.auth.requiresVerification",
          ),
          !normalizedCode,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      const directoryServicesIdentifier =
        directoryServicesIdentifierFromResponse(dict, response);
      if (!directoryServicesIdentifier) {
        throw new Error(i18n.t("errors.auth.missingDsid"));
      }

      const account: Account = {
        email: appleId,
        password,
        appleId: String(accountInfo.appleId || appleId),
        store: storeFront,
        storeFront: fullStoreFront || undefined,
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier,
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw e;
      }
      if (e instanceof AuthenticationAttemptRetryError) {
        lastError = e;
        continue;
      }
      if (e instanceof AuthenticationRetryExhaustedError) {
        // A native endpoint that keeps answering 204/404 is not a credential
        // refusal; it usually means this endpoint wants Store AMD and never
        // emitted the SP action. Try the legacy storefront endpoint once.
        if (
          !triedAltEndpoint &&
          (e.status === 204 || e.status === 404)
        ) {
          triedAltEndpoint = true;
          requestHost = altAuthEndpoint.hostname;
          requestPath = `${altAuthEndpoint.pathname}${altAuthEndpoint.search}`;
          currentAttempt--;
          await refreshAnisetteHeaders();
          continue;
        }
        // The wrapper already retried this answered-but-unusable response
        // three times; another whole-attempt retry only multiplies a refusal
        // or rate-limit hit.
        throw e;
      }
      // Only a request that never reached Apple is worth retrying. A refusal
      // answers with a response, and retrying a structured failure with the
      // same attempt number (or at all) is not the ipatool behavior.
      if (!(e instanceof AppleUnreachableError)) {
        throw e;
      }
      lastError = e;
      if (!triedAltEndpoint) {
        triedAltEndpoint = true;
        requestHost = altAuthEndpoint.hostname;
        requestPath = `${altAuthEndpoint.pathname}${altAuthEndpoint.search}`;
        currentAttempt--;
        await refreshAnisetteHeaders();
      }
    }
  }

  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}

/**
 * Apple's sign-in endpoint transiently answers 204/403/404/429/5xx. A response
 * carrying a plist is an answer — including a populated credential/2FA refusal
 * — so only an empty or non-plist body is retried. A response carrying an AMD
 * action is machine provisioning and is returned immediately.
 */
async function sendAuthenticationRequest(
  options: Parameters<typeof appleRequest>[0],
  machineValidation: boolean,
  onResponse?: (response: AppleResponse) => Cookie[] | void,
): Promise<AppleResponse> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await appleRequest(options);
      const updatedCookies = onResponse?.(response);
      if (updatedCookies) options.cookies = updatedCookies;
      if (machineActionFromResponse(response.headers)) return response;

      if (shouldRetryAuthenticationResponse(response, machineValidation)) {
        lastError = new AuthenticationRetryExhaustedError(
          i18n.t("errors.auth.retryExhausted", { status: response.status }),
          response.status,
        );
        // This was the last request. Sleeping here would only keep the UI
        // waiting for a retry that cannot happen.
        if (attempt === 2) throw lastError;
        if (response.status === 429) {
          const delay = authenticationRateLimitDelayMs(response, attempt);
          // Apple asked for a wait longer than a browser sign-in can hide;
          // surface the rate limit instead of pretending to retry.
          if (delay === null) throw lastError;
          await sleep(delay);
        } else {
          await sleep(AUTH_SHORT_RETRY_MS * (attempt + 1));
        }
        continue;
      }

      return response;
    } catch (error) {
      if (!(error instanceof AppleUnreachableError)) throw error;
      // A transport failure says nothing about this endpoint's answer; the
      // outer loop moves to Apple's other auth endpoint immediately.
      throw error;
    }
  }

  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}

function shouldRetryAuthenticationResponse(
  response: AppleResponse,
  machineValidation: boolean,
): boolean {
  if (!isRetryableAuthenticationStatus(response.status, machineValidation)) {
    return false;
  }
  if (!response.body.trim()) return true;

  try {
    parsePlist(response.body);
    return false;
  } catch {
    return true;
  }
}

function isRetryableAuthenticationStatus(
  status: number,
  machineValidation: boolean,
): boolean {
  return (
    status === 403 ||
    status === 429 ||
    status >= 500 ||
    (machineValidation && (status === 204 || status === 404))
  );
}

/**
 * Go upstream treats 429 as a real rate limit: honour Retry-After and use a
 * 10s/20s exponential fallback, refusing waits longer than 30s. Retrying a
 * 429 after 250ms hammers a limit that is already active and can extend it.
 */
function authenticationRateLimitDelayMs(
  response: AppleResponse,
  attempt: number,
): number | null {
  const requested = retryAfterMs(response.headers["retry-after"]);
  if (requested !== null) {
    if (requested > AUTH_RETRY_MAX_MS) return null;
    return Math.max(1000, requested);
  }

  return Math.min(
    AUTH_RETRY_BASE_MS * 2 ** attempt,
    AUTH_RETRY_MAX_MS,
  );
}

function retryAfterMs(value: string | undefined): number | null {
  if (!value) return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * `dsPersonId` is the normal source; some replies put the same value in
 * `X-Dsid` or in an `mz_at`/`mz_at_ssl` cookie. ipatool 2.8.0 accepts all
 * three, and a missing DSID cannot drive any later Store request.
 */
export function directoryServicesIdentifierFromResponse(
  dict: Record<string, any>,
  response: Pick<AppleResponse, "headers" | "rawHeaders">,
): string {
  const direct = String(dict.dsPersonId ?? "").trim();
  if (direct) return direct;

  const header = response.headers["x-dsid"]?.trim();
  if (header) return header;

  const cookieDsid = new RegExp(
    ["(?:^|[ ,])", "mz", "_at", "(?:0|_ssl)-([0-9]+)="].join(""),
  );
  for (const [name, value] of response.rawHeaders) {
    if (name.toLowerCase() !== "set-cookie") continue;
    const match = cookieDsid.exec(value);
    if (match?.[1]) return match[1];
  }

  return "";
}

function dialogFromResponseBody(body: string): string | null {
  try {
    return authenticationDialogError(parsePlist(body) as Record<string, any>);
  } catch {
    return null;
  }
}

function authenticationDialogError(
  dict: Record<string, any>,
): string | null {
  const dialog = (dict.dialog ?? {}) as Record<string, any>;
  const message = String(dialog.message ?? "").trim();
  const explanation = String(dialog.explanation ?? "").trim();
  const okButtonString = String(dialog.okButtonString ?? "").trim();
  const cancelButtonString = String(dialog.cancelButtonString ?? "").trim();
  const action = (dialog.okButtonAction ?? {}) as Record<string, any>;
  const actionKind = String(action.kind ?? "").trim();
  const actionRawURL = String(action.url ?? "").trim();
  const actionURL = trustedDialogURL(
    actionKind,
    actionRawURL,
  );
  const customerMessage = String(dict.customerMessage ?? "").trim();

  if (
    !message &&
    !explanation &&
    !okButtonString &&
    !cancelButtonString &&
    !actionKind &&
    !actionRawURL
  ) {
    return null;
  }

  const title = message || customerMessage;
  const detail = [title, explanation !== title ? explanation : ""]
    .filter(Boolean)
    .join(": ");

  if (!detail && !actionURL) return null;

  const label = okButtonString || "Continue";
  return actionURL
    ? `${detail || "Apple requires action before sign-in can continue"} (${label}: ${actionURL})`
    : detail;
}

function trustedDialogURL(kind: string, raw: string): string {
  if (kind.trim().toLowerCase() !== "openurl" || !raw) return "";

  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port !== "" && url.port !== "443") ||
      !isAppleHost(url.hostname)
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}
