import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL } from "./bag";
import { authStoreFront } from "./config";
import { AppleUnreachableError } from "./errors";
import { prepareSigner } from "./sap/client";
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

export async function authenticate(
  appleId: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let lastError: Error | null = null;

  // A sign-in goes to the storefront endpoint the bag advertises. fetchBag
  // answers with Apple's native endpoint whenever the bag cannot be read, so
  // there is always one to call.
  const bag = await fetchBag(deviceId);
  const bagEndpoint = new URL(bag.authURL);
  bagEndpoint.searchParams.set("guid", deviceId);
  let requestHost = bagEndpoint.hostname;
  let requestPath = `${bagEndpoint.pathname}${bagEndpoint.search}`;

  // Apple answers sign-ins on two equivalent endpoints: the storefront one
  // above, and the native one. They do not fail together — measured from one
  // network, the storefront host's address pool went silent for minutes at a
  // time while the native endpoint answered every request — so a request that
  // never reached Apple is worth repeating on the other one before the sign-in
  // is called off.
  const altAuthEndpoint = new URL(defaultAuthURL);
  altAuthEndpoint.searchParams.set("guid", deviceId);
  let triedAltEndpoint =
    altAuthEndpoint.hostname === bagEndpoint.hostname &&
    altAuthEndpoint.pathname === bagEndpoint.pathname;

  // When the bag advertises the SAP signing protocol, every request to the
  // auth endpoint must carry X-Apple-ActionSignature over its body bytes.
  // The signer sees only the hardware ID and public Apple assets — never the
  // password — because signing happens here in the browser. It is kept as a
  // singleton between attempts (2FA retries reuse the same session).
  let sapSigner = null as Awaited<ReturnType<typeof prepareSigner>> | null;
  if (bag.sapEndpoints) {
    sapSigner = await prepareSigner(deviceId, bag.sapEndpoints);
  }

  let currentAttempt = 0;
  let redirectAttempt = 0;

  while (currentAttempt < 2 && redirectAttempt <= 3) {
    currentAttempt++;

    try {
      const body: Record<string, string> = {
        appleId,
        attempt: code ? "2" : "4",
        guid: deviceId,
        password: code ? `${password}${code}` : password,
        rmp: "0",
        why: "signIn",
      };

      const plistBody = buildPlist(body);

      const headers: Record<string, string> = {
        "Content-Type": "application/x-apple-plist",
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

      const response = await appleRequest({
        method: "POST",
        host: requestHost,
        path: requestPath,
        headers,
        body: plistBody,
        cookies,
      });

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        const parts = storeHeader.split("-");
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;

      // Handle redirect. The native /fast auth host can answer with 301 as
      // well as the usual 302, so follow the full set of redirect statuses.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          throw new Error(i18n.t("errors.auth.redirectLocation"));
        }
        const url = new URL(location);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        throw new Error(
          i18n.t("errors.auth.emptyBody", { status: response.status }),
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      // Check for 2FA requirement. Apple answers with the same message both
      // when it wants a code and when it refused the one it was sent — only
      // whether the caller supplied one tells the two apart.
      if (
        dict.failureType === "" &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        throw new AuthenticationError(
          i18n.t(
            code
              ? "errors.auth.verificationIncomplete"
              : "errors.auth.requiresVerification",
          ),
          !code,
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

      const account: Account = {
        email: appleId,
        password,
        appleId: (accountInfo.appleId as string) ?? "",
        store: storeFront,
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
      // Only a request that never reached Apple is worth repeating somewhere
      // else — Apple refusing the sign-in answers with a response, not an
      // error. Keeping the try count means the other endpoint gets the same
      // two tries this one had.
      if (!triedAltEndpoint && e instanceof AppleUnreachableError) {
        triedAltEndpoint = true;
        requestHost = altAuthEndpoint.hostname;
        requestPath = `${altAuthEndpoint.pathname}${altAuthEndpoint.search}`;
        currentAttempt--;
      }
    }
  }

  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}
