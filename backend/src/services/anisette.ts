import { randomBytes } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import { fileURLToPath } from "url";
import {
  ensureAppleCache,
  helperCacheEnv,
  helperProcessEnv,
} from "./appleCache.js";

/**
 * The Anisette helper owns Apple's ADI/FairPlay guest. It never receives the
 * account password, cookies, or password token: callers send only a device
 * identifier, an opaque provisioning state, Apple's machine-action challenge,
 * and the public endpoint the proof is bound to.
 */
export const ANISETTE_HELPER_CANDIDATES = [
  process.env.ANISETTE_HELPER_PATH,
  "/opt/asspp/anisette",
  fileURLToPath(
    new URL(
      `../../../tools/anisette/anisette${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  ),
].filter((candidate): candidate is string => Boolean(candidate));

const HELPER_START_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_HEADERS_TIMEOUT_MS = 2 * 60 * 1000;
const AUTH_ACTION_TIMEOUT_MS = 2 * 60 * 1000;
const STORE_PROOF_TIMEOUT_MS = 60_000;
/**
 * How long a cold helper may still be loading Apple's bundle before a proof
 * timeout is treated as a stall. The helper runs that load on its own
 * ten-minute budget; this adds room for the helper's own startup.
 */
const COLD_START_GRACE_MS = 12 * 60 * 1000;

export class AnisetteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnisetteUnavailableError";
  }
}

/** The helper answered, but Apple's provisioning/proof step failed. */
export class AnisetteHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnisetteHelperError";
  }
}

export interface AnisetteHeadersResult {
  state: string;
  headers: Record<string, string>;
  provisioned?: boolean;
  family?: string;
}

export interface AnisetteActionResult {
  state: string;
  headers?: Record<string, string>;
  dropMachineHeaders?: boolean;
  family?: string;
}

export interface RunningHelper {
  child: ChildProcess;
  port: number;
  token: string;
  stderr: string;
  startedAt: number;
}

let helperPromise: Promise<RunningHelper> | null = null;
let runningHelper: RunningHelper | null = null;
let helperRequestSequence = 0;
const activeHelperRequests = new Set<number>();
/**
 * The subset of helper requests that serialize on `proofMu`. `/v1/prepare`
 * only uses `prepareMu`, so a prepare call must not make a timed-out proof
 * look queued behind another caller.
 */
const activeProofRequests = new Set<number>();

/**
 * Finds the helper the image bakes or the dev checkout builds. The explicit
 * environment override exists for tests and non-standard deployments.
 */
export function findAnisetteHelper(): string | undefined {
  return ANISETTE_HELPER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

export function isAnisetteHelperRunning(): boolean {
  return runningHelper !== null && !hasExited(runningHelper.child);
}

export function anisetteStatus(): {
  available: boolean;
  running: boolean;
  helperPath?: string;
  error?: string;
} {
  const helperPath = findAnisetteHelper();
  return {
    available: Boolean(helperPath),
    running: isAnisetteHelperRunning(),
    ...(helperPath ? { helperPath } : {}),
  };
}

/**
 * Starts the helper once. A helper that exits is dropped so the next request
 * starts a fresh one instead of talking to a dead port.
 */
export function ensureAnisetteHelper(): Promise<RunningHelper> {
  if (runningHelper && !hasExited(runningHelper.child)) {
    return Promise.resolve(runningHelper);
  }

  if (!helperPromise) {
    helperPromise = startHelper().finally(() => {
      helperPromise = null;
    });
  }

  return helperPromise;
}

async function startHelper(): Promise<RunningHelper> {
  const helperPath = findAnisetteHelper();
  if (!helperPath) {
    throw new AnisetteUnavailableError(
      `this server has no Anisette helper (expected it at ${ANISETTE_HELPER_CANDIDATES.join(" or ")})`,
    );
  }

  await ensureAppleCache();

  const port = await getFreePort();
  const token = randomBytes(32).toString("hex");
  // Go's time.Local is "Local" on macOS, and Apple rejects that as an
  // X-Apple-I-Timezone value. Give the helper an IANA zone even when the
  // backend was started without TZ.
  const timeZone =
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const child = spawn(
    helperPath,
    ["serve", "-listen", `127.0.0.1:${port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...helperProcessEnv(),
        TZ: timeZone,
        ANISETTE_HELPER_TOKEN: token,
        ...helperCacheEnv(),
      },
    },
  );

  const record: RunningHelper = {
    child,
    port,
    token,
    stderr: "",
    startedAt: Date.now(),
  };

  child.once("error", (error) => {
    record.stderr = `${record.stderr}\nspawn: ${error.message}`.slice(-4000);
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) console.log(`[anisette] ${line.trim()}`);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    record.stderr = (record.stderr + chunk).slice(-4000);
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) console.warn(`[anisette] ${line.trim()}`);
    }
  });

  child.once("exit", (code, signal) => {
    if (runningHelper === record) runningHelper = null;
    if (code !== 0 && code !== null) {
      console.warn(
        `[anisette] helper exited with code ${code}${signal ? ` (${signal})` : ""}`,
      );
    }
  });

  const deadline = Date.now() + HELPER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited(child) || child.pid === undefined) {
      throw new AnisetteUnavailableError(
        `the Anisette helper exited before it was ready: ${
          record.stderr.trim() || exitDescription(child)
        }`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        runningHelper = record;
        return record;
      }
    } catch {
      // Not listening yet; keep polling until the deadline.
    }

    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  child.kill("SIGKILL");
  throw new AnisetteUnavailableError(
    `the Anisette helper did not become ready within ${HELPER_START_TIMEOUT_MS / 1000}s: ${record.stderr.trim() || "no output"}`,
  );
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        address && typeof address === "object" ? address.port : undefined;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new Error("could not allocate a loopback port"));
      });
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitDescription(child: ChildProcess): string {
  if (child.pid === undefined) return "spawn failed";
  if (child.signalCode) return `signal ${child.signalCode}`;
  return `code ${child.exitCode}`;
}

/**
 * Whether the helper has finished loading Apple's asset bundle. While it has
 * not, no proof can be holding `proofMu`: every proof handler calls
 * `loadBundle` before it locks. A proof that times out then is waiting for the
 * bundle (normally behind `/v1/prepare`, which has its own ten-minute budget),
 * not for a wedged proof — and killing the helper would abort a healthy
 * extraction that cannot resume. A helper that does not answer this probe is
 * treated as loaded so the previous kill-on-timeout behavior stands.
 */
async function helperLoadedBundle(helper: RunningHelper): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${helper.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return true;

    const data = (await response.json()) as { bundleReady?: unknown };
    return data.bundleReady !== false;
  } catch {
    return true;
  }
}

async function helperRequest<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  retry = true,
): Promise<T> {
  const helper = await ensureAnisetteHelper();
  const requestId = ++helperRequestSequence;
  const proofRequest = path !== "/v1/prepare";
  activeHelperRequests.add(requestId);
  if (proofRequest) activeProofRequests.add(requestId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://127.0.0.1:${helper.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${helper.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text || `HTTP ${response.status}` };
    }

    if (!response.ok) {
      const message =
        typeof data.error === "string"
          ? data.error
          : `Anisette helper returned HTTP ${response.status}`;
      throw new AnisetteHelperError(message);
    }

    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // The helper serializes proof handlers with proofMu. Only the oldest
      // proof call can be the one holding that lock; a queued proof timing out
      // must not kill the helper and abort the work it is waiting for.
      // `/v1/prepare` uses prepareMu instead, so it belongs to the broader
      // startup/warmup set rather than the proof set.
      const contenders = proofRequest
        ? activeProofRequests
        : activeHelperRequests;
      // A cold helper is still loading its bundle, so no proof holds proofMu
      // yet: a timed-out proof is queued on that load, not wedged. Leave the
      // helper alone while the load is inside its grace period; a load that
      // outlives it is a stall and is killed as before.
      const coldStart =
        proofRequest &&
        Date.now() - helper.startedAt < COLD_START_GRACE_MS &&
        !(await helperLoadedBundle(helper));
      if (!coldStart && Math.min(...contenders) === requestId) {
        stopHelper(helper);
      }
      throw new AnisetteUnavailableError(
        `the Anisette helper did not answer within ${Math.round(timeoutMs / 1000)}s`,
      );
    }

    if (hasExited(helper.child) && retry) {
      activeHelperRequests.delete(requestId);
      activeProofRequests.delete(requestId);
      if (runningHelper === helper) runningHelper = null;
      return helperRequest(path, body, timeoutMs, false);
    }

    if (error instanceof AnisetteUnavailableError) throw error;
    if (error instanceof AnisetteHelperError) throw error;

    throw new AnisetteUnavailableError(
      `the Anisette helper could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    activeHelperRequests.delete(requestId);
    activeProofRequests.delete(requestId);
    clearTimeout(timer);
  }
}

export async function prepareAnisette(): Promise<void> {
  await helperRequest("/v1/prepare", {}, PREPARE_TIMEOUT_MS);
}

export function requestAuthHeaders(
  deviceIdentifier: string,
  state: string,
  authEndpoint: string,
  family?: string,
): Promise<AnisetteHeadersResult> {
  return helperRequest(
    "/v1/auth/headers",
    { deviceIdentifier, state, authEndpoint, ...(family ? { family } : {}) },
    AUTH_HEADERS_TIMEOUT_MS,
  );
}

export function requestAuthAction(
  deviceIdentifier: string,
  state: string,
  action: string,
  data: string,
  authEndpoint: string,
  identityHeaders: Record<string, string>,
  options: { family?: string; finishUrl?: string } = {},
): Promise<AnisetteActionResult> {
  return helperRequest(
    "/v1/auth/action",
    {
      deviceIdentifier,
      state,
      action,
      data,
      authEndpoint,
      identityHeaders,
      ...(options.family ? { family: options.family } : {}),
      ...(options.finishUrl ? { finishUrl: options.finishUrl } : {}),
    },
    AUTH_ACTION_TIMEOUT_MS,
  );
}

export function requestStoreProof(
  deviceIdentifier: string,
  state: string,
  endpoint: string,
  family?: string,
): Promise<AnisetteHeadersResult> {
  return helperRequest(
    "/v1/store/proof",
    { deviceIdentifier, state, endpoint, ...(family ? { family } : {}) },
    STORE_PROOF_TIMEOUT_MS,
  );
}

/** Stops the helper; tests and process shutdown use it. */
export function stopAnisetteHelper(): void {
  if (runningHelper) {
    stopHelper(runningHelper);
  }
  helperPromise = null;
}

/** Stops one specific helper without disturbing a newer replacement. */
function stopHelper(helper: RunningHelper): void {
  helper.child.kill();
  if (runningHelper === helper) {
    runningHelper = null;
    helperPromise = null;
  }
}
