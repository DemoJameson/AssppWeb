import type { BagOutput } from "./bag";
import type { AppleResponse } from "./request";
import {
  fetchStoreProof,
  handleAuthAction,
  runAnisetteTask,
  type AnisetteFamily,
  type AnisetteActionResult,
} from "./anisette";
import { getAnisetteState, setAnisetteState } from "./anisetteStore";
import i18n from "../i18n";

export interface MachineAction {
  family: AnisetteFamily;
  action: string;
  data: string;
}

/**
 * Apple names the same provisioning handshake under two header families:
 * `X-Apple-MD-*` (the general/StoreAgent family) and `X-Apple-AMD-*`
 * (AppleMediaServices). The action must be read before a redirect or body is
 * interpreted, because an empty 204/404 carrying it is a provisioning request,
 * not a failed sign-in or download.
 */
export function machineActionFromResponse(
  headers: Record<string, string>,
): MachineAction | null {
  const md = headers["x-apple-md-action"]?.trim();
  if (md) {
    return {
      family: "md",
      action: md.toUpperCase(),
      data: headers["x-apple-md-data"] ?? "",
    };
  }

  const amd = headers["x-apple-amd-action"]?.trim();
  if (amd) {
    return {
      family: "amd",
      action: amd.toUpperCase(),
      data: headers["x-apple-amd-data"] ?? "",
    };
  }

  return null;
}

/** Remove every machine-validation header, whichever family produced it. */
export function stripMachineHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const machine = new Set([
    "x-apple-amd",
    "x-apple-amd-m",
    "x-apple-md",
    "x-apple-md-m",
    "x-apple-i-md",
    "x-apple-i-md-m",
    "x-apple-i-md-rinfo",
  ]);

  for (const [key, value] of Object.entries(headers)) {
    if (!machine.has(key.toLowerCase())) out[key] = value;
  }

  return out;
}

/** The bag's provisioning endpoint for the family Apple asked for. */
export function finishProvisioningURL(
  bag: BagOutput | null | undefined,
  family: AnisetteFamily,
): string | undefined {
  return family === "md"
    ? bag?.mdFinishProvisioning
    : bag?.amdFinishProvisioning;
}

/**
 * The only credential-free identity headers the Anisette helper accepts.
 * Keep this in sync with IDENTITY_HEADERS in backend/src/routes/anisette.ts
 * and isIdentityHeader in tools/anisette/server.go. Filtering here matters:
 * commerce requests also carry X-Token, X-Dsid and iCloud-DSID, and those must
 * never leave the browser on their way to the helper.
 */
const HELPER_IDENTITY_HEADERS = new Set([
  "x-apple-i-client-time",
  "x-apple-i-md-lu",
  "x-apple-i-srl-no",
  "x-apple-i-timezone",
  "x-apple-locale",
  "x-mme-device-id",
  "x-mme-client-info",
]);

function helperIdentityHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HELPER_IDENTITY_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A proof stays valid long enough to cover the page's own lookups and the
 * download click that follows them. Apple binds it to the exact endpoint, so
 * the key carries the URL as well as the device.
 */
const STORE_PROOF_TTL_MS = 2 * 60 * 1000;
const proofCache = new Map<
  string,
  { at: number; headers: Record<string, string> }
>();
/** One generation per endpoint: concurrent lookups and a click share it. */
const proofInFlight = new Map<string, Promise<Record<string, string>>>();

function proofKey(deviceIdentifier: string, endpoint: string): string {
  return `${deviceIdentifier}:${endpoint}`;
}

function cacheStoreProof(
  deviceIdentifier: string,
  endpoint: string,
  headers: Record<string, string>,
): void {
  if (Object.keys(headers).length === 0) return;
  proofCache.set(proofKey(deviceIdentifier, endpoint), {
    at: Date.now(),
    headers,
  });
}

/** Apple rejected the machine headers; the next attempt must mint a fresh proof. */
function forgetStoreProof(deviceIdentifier: string, endpoint: string): void {
  proofCache.delete(proofKey(deviceIdentifier, endpoint));
}

/** Test hook: a cached proof must not leak across cases or page sessions. */
export function clearStoreProofCache(): void {
  proofCache.clear();
  proofInFlight.clear();
}

/**
 * Ask the helper for a URL-bound Store proof. No state means this browser has
 * never completed machine provisioning; the request still goes out and Apple's
 * own answer decides, matching the auth flow.
 */
export async function storeProofHeaders(
  deviceIdentifier: string,
  endpoint: string,
): Promise<Record<string, string>> {
  const key = proofKey(deviceIdentifier, endpoint);
  const cached = proofCache.get(key);
  if (cached && Date.now() - cached.at < STORE_PROOF_TTL_MS) {
    return cached.headers;
  }

  const running = proofInFlight.get(key);
  if (running) return running;

  const proof = runAnisetteTask(deviceIdentifier, async () => {
    const state = await getAnisetteState(deviceIdentifier);
    if (!state) return {};

    try {
      const result = await fetchStoreProof(deviceIdentifier, state, endpoint);
      await setAnisetteState(deviceIdentifier, result.state);
      cacheStoreProof(deviceIdentifier, endpoint, result.headers);
      return result.headers;
    } catch (error) {
      console.warn(
        `[anisette] store proof unavailable for ${endpoint.split("?")[0]}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {};
    }
  });
  proofInFlight.set(key, proof);
  try {
    return await proof;
  } finally {
    if (proofInFlight.get(key) === proof) proofInFlight.delete(key);
  }
}

/**
 * Complete Apple's SP provisioning action and return the fresh machine headers
 * for the family the server asked for.
 */
export async function provisionMachineAction(
  deviceIdentifier: string,
  action: MachineAction,
  proofEndpoint: string,
  identityHeaders: Record<string, string>,
  bag?: BagOutput | null,
): Promise<AnisetteActionResult> {
  if (action.action !== "SP") {
    throw new Error(
      i18n.t("errors.auth.deviceVerificationUnsupported", {
        action: action.action,
      }),
    );
  }

  return runAnisetteTask(deviceIdentifier, async () => {
    const state = await getAnisetteState(deviceIdentifier);
    if (!state) {
      throw new Error(i18n.t("errors.auth.deviceVerificationState"));
    }

    const identity = helperIdentityHeaders(identityHeaders);
    const result = await handleAuthAction(
      deviceIdentifier,
      state,
      "SP",
      action.data,
      proofEndpoint,
      identity,
      {
        family: action.family,
        finishUrl: finishProvisioningURL(bag, action.family),
      },
    );
    await setAnisetteState(deviceIdentifier, result.state);
    cacheStoreProof(deviceIdentifier, proofEndpoint, result.headers ?? {});
    return result;
  });
}

export interface MachineValidatedRequestOptions {
  deviceIdentifier: string;
  endpoint: string;
  bag?: BagOutput | null;
  headers: Record<string, string>;
  send: (headers: Record<string, string>) => Promise<AppleResponse>;
  /** Called for every response, including RP/SP actions, before any replay. */
  onResponse?: (response: AppleResponse) => void;
  maxActionRounds?: number;
}

/**
 * Send one commerce request, attach a fresh URL-bound proof, and transparently
 * answer RP/SP machine actions before returning Apple's final response. This is
 * the commerce counterpart of the sign-in loop: Apple can ask for machine
 * provisioning on download and purchase requests too.
 */
export async function sendMachineValidatedRequest(
  options: MachineValidatedRequestOptions,
): Promise<AppleResponse> {
  const maxActionRounds = options.maxActionRounds ?? 2;
  let headers = stripMachineHeaders(options.headers);
  let suppressProof = false;
  let useExistingProof = false;
  let smRetried = false;

  for (let round = 0; ; round++) {
    if (suppressProof) {
      headers = stripMachineHeaders(headers);
    } else if (!useExistingProof) {
      const proof = await storeProofHeaders(
        options.deviceIdentifier,
        options.endpoint,
      );
      headers = { ...stripMachineHeaders(headers), ...proof };
    }
    useExistingProof = false;

    const response = await options.send(headers);
    options.onResponse?.(response);
    const action = machineActionFromResponse(response.headers);
    if (!action) return response;

    // ipatool-cpp logs SM (machine sync) and continues because it does not
    // implement the sync exchange. Handle SM (and any other unknown action)
    // before the action-round cap: a sync request after RP/SP is not a
    // provisioning loop and must not abort the whole download.
    if (action.action !== "RP" && action.action !== "SP") {
      console.warn(
        `[machine] Apple requested unsupported action ${action.action}; continuing without machine headers`,
      );
      if (action.action === "SM" && !smRetried) {
        smRetried = true;
        suppressProof = true;
        continue;
      }
      return response;
    }

    if (round >= maxActionRounds) {
      throw new Error(
        i18n.t("errors.auth.deviceVerificationLoop", { action: action.action }),
      );
    }

    if (action.action === "RP") {
      forgetStoreProof(options.deviceIdentifier, options.endpoint);
      suppressProof = true;
      continue;
    }

    if (action.action === "SP") {
      const result = await provisionMachineAction(
        options.deviceIdentifier,
        action,
        options.endpoint,
        headers,
        options.bag,
      );
      headers = stripMachineHeaders(headers);
      headers = { ...headers, ...(result.headers ?? {}) };
      suppressProof = false;
      useExistingProof = Object.keys(result.headers ?? {}).length > 0;
      continue;
    }
  }
}
