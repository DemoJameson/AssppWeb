import { apiPost } from "../api/client";

export type AnisetteFamily = "amd" | "md";

export interface AnisetteHeadersResult {
  state: string;
  headers: Record<string, string>;
  provisioned?: boolean;
  family?: AnisetteFamily;
}

export interface AnisetteActionResult {
  state: string;
  headers?: Record<string, string>;
  dropMachineHeaders?: boolean;
  family?: AnisetteFamily;
}

export interface AuthActionOptions {
  /** The header family Apple named in its action response. */
  family?: AnisetteFamily;
  /** The bag's provisioning endpoint for that family. */
  finishUrl?: string;
}

/**
 * Apple's ADI state is a snapshot: two proofs started from the same state can
 * invalidate each other. Serialize every state-reading/proof-writing call for
 * one device, so the next call starts from the state the previous one wrote.
 * Do not nest calls for the same device: Web Locks are not reentrant.
 */
const stateQueues = new Map<string, Promise<unknown>>();

/**
 * The state queue above only orders work inside one tab. The state itself is
 * shared by every tab through IndexedDB, so two tabs can still read the same
 * snapshot and write conflicting successors. Serialize the whole
 * read/proof/write transaction across tabs with the Web Locks API when it is
 * available; browsers without it keep the per-tab queue.
 */
async function withCrossTabLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const locks =
    typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return task();

  return locks.request(`asspp-anisette:${key}`, () => task());
}

export function runAnisetteTask<T>(
  deviceIdentifier: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = deviceIdentifier || "default";
  const previous = stateQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => withCrossTabLock(key, task));
  stateQueues.set(key, current);

  return current.finally(() => {
    if (stateQueues.get(key) === current) stateQueues.delete(key);
  });
}

/**
 * Starts the backend helper and warms Apple's assets/Unicorn runtime. This is
 * best-effort: the real auth request still waits for the helper if it is slow.
 */
export async function prepareAnisette(): Promise<void> {
  await apiPost("/api/anisette/prepare", undefined, {
    timeoutMs: 10 * 60 * 1000,
  });
}

export function fetchAuthHeaders(
  deviceIdentifier: string,
  state: string | undefined,
  authEndpoint: string,
): Promise<AnisetteHeadersResult> {
  return apiPost(
    "/api/anisette/auth/headers",
    {
      deviceIdentifier,
      state: state ?? "",
      authEndpoint,
    },
    { timeoutMs: 2 * 60 * 1000 },
  );
}

export function handleAuthAction(
  deviceIdentifier: string,
  state: string,
  action: string,
  data: string,
  authEndpoint: string,
  identityHeaders: Record<string, string>,
  options: AuthActionOptions = {},
): Promise<AnisetteActionResult> {
  return apiPost(
    "/api/anisette/auth/action",
    {
      deviceIdentifier,
      state,
      action,
      data,
      authEndpoint,
      identityHeaders,
      ...options,
    },
    { timeoutMs: 2 * 60 * 1000 },
  );
}

export function fetchStoreProof(
  deviceIdentifier: string,
  state: string,
  endpoint: string,
  family?: AnisetteFamily,
): Promise<AnisetteHeadersResult> {
  return apiPost(
    "/api/anisette/store/proof",
    { deviceIdentifier, state, endpoint, ...(family ? { family } : {}) },
    { timeoutMs: 60 * 1000 },
  );
}
