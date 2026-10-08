// Main-thread SAP signer manager. A module-level singleton bound to the
// hardware id it was built with, since making the worker copies the ~22.5 MB
// asset bundle. `prepareSigner` reuses a matching signer or rebuilds for another
// account, sharing concurrent callers; UI progress lives in store/sap.ts.

import { SapSigner, type SapMachineDriver } from "./signer";
import { exchangeSetupBuffer, fetchSetupCertificate } from "./protocol";
import { loadSapAssets } from "./assets";
import type { SapEndpoints } from "./types";
import { useSapStore } from "../../store/sap";
import i18n from "../../i18n";

interface WorkerResult {
  type: "result";
  id: number;
  [key: string]: unknown;
}

interface WorkerError {
  type: "error";
  id: number;
  message: string;
}

/**
 * How long one call into the emulation may take. Nothing else bounds these —
 * calls run before the Apple request they sign for, so its timeout never sees
 * them and a wedged worker would leave the sign-in button spinning. The
 * interpreter is deterministic (~4 s per preparation), so a call still out at
 * two minutes is wedged, not slow: give the signer up.
 */
export const SAP_CALL_TIMEOUT_MS = 2 * 60 * 1000;

class WorkerMachineDriver implements SapMachineDriver {
  private nextId = 1;
  /** Set once a call has run past its timeout: the worker is done for. */
  private wedged = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: WorkerResult) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly worker: Worker,
    /**
     * Called after a call passes {@link SAP_CALL_TIMEOUT_MS}: the worker is not
     * coming back, so it must not be reused or re-offered to the next attempt.
     */
    private readonly onWedged: () => void = () => undefined,
  ) {
    worker.onmessage = (event: MessageEvent<WorkerResult | WorkerError>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      if (message.type === "error") {
        entry.reject(new Error(message.message));
      } else {
        entry.resolve(message);
      }
    };
  }

  call(
    request: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<WorkerResult> {
    if (this.wedged) {
      // The worker is gone; any further call would just wait out another timeout.
      return Promise.reject(new Error(i18n.t("errors.auth.signerTimeout")));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wedged = true;
        this.pending.delete(id);
        this.onWedged();
        reject(new Error(i18n.t("errors.auth.signerTimeout")));
      }, SAP_CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.worker.postMessage({ ...request, id }, transfer ?? []);
    });
  }

  async close(): Promise<void> {
    if (this.wedged) {
      this.terminate();
      return;
    }
    await this.call({ type: "close" });
    this.worker.terminate();
  }

  /** Drops the worker without waiting for it to acknowledge anything. */
  terminate(): void {
    // In-flight calls lost their worker; reject now so callers are not left on
    // a promise nothing can resolve.
    for (const entry of this.pending.values()) {
      entry.reject(new Error(i18n.t("errors.auth.signerTimeout")));
    }
    this.pending.clear();
    this.worker.terminate();
  }

  async open(
    assets: {
      commerceKit: Uint8Array;
      commerceCore: Uint8Array;
      coreFP: Uint8Array;
      coreFPICXS: Uint8Array;
    },
    wasmBinary: ArrayBuffer,
  ): Promise<void> {
    // Transfer the buffers instead of copying ~22.5 MB: the emulation is the
    // only consumer and a rebuild re-reads from the Cache API, so nothing here
    // touches them after open(). Only the module-level wasm cache outlives a
    // preparation, so it is copied.
    const buffers = {
      commerceKit: assets.commerceKit.buffer as ArrayBuffer,
      commerceCore: assets.commerceCore.buffer as ArrayBuffer,
      coreFP: assets.coreFP.buffer as ArrayBuffer,
      coreFPICXS: assets.coreFPICXS.buffer as ArrayBuffer,
    };
    const wasmCopy = wasmBinary.slice(0);

    await this.call(
      { type: "open", assets: buffers, wasmBinary: wasmCopy },
      [...Object.values(buffers), wasmCopy],
    );
  }

  async initialize(hardwareID: Uint8Array): Promise<number> {
    const copy = hardwareID.slice();
    const result = await this.call({
      type: "initialize",
      hardwareID: copy.buffer,
    });
    return result.contextValue as number;
  }

  async exchange(
    version: number,
    hardwareID: Uint8Array,
    contextValue: number,
    input: Uint8Array,
  ): Promise<{ output: Uint8Array; state: number }> {
    const hw = hardwareID.slice();
    const payload = input.slice();
    const result = await this.call({
      type: "exchange",
      version,
      hardwareID: hw.buffer,
      contextValue,
      input: payload.buffer,
    });
    return {
      output: new Uint8Array(result.output as ArrayBuffer),
      state: result.state as number,
    };
  }

  async sign(contextValue: number, input: Uint8Array): Promise<Uint8Array> {
    const payload = input.slice();
    const result = await this.call({
      type: "sign",
      contextValue,
      input: payload.buffer,
    });
    return new Uint8Array(result.signature as ArrayBuffer);
  }

  async teardown(contextValue: number): Promise<void> {
    await this.call({ type: "teardown", contextValue });
  }
}

interface PreparedSigner {
  signer: SapSigner;
  driver: WorkerMachineDriver;
  hardwareID: string;
  endpoints: SapEndpoints;
}

let prepared: PreparedSigner | null = null;
let preparation: Promise<PreparedSigner> | null = null;
let wasmBinary: ArrayBuffer | null = null;

async function loadWorkerWasmBinary(): Promise<ArrayBuffer> {
  if (wasmBinary) {
    return wasmBinary;
  }
  const url = new URL("./vendor/unicorn.wasm", import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SAP engine download failed: HTTP ${response.status}`);
  }
  wasmBinary = await response.arrayBuffer();
  return wasmBinary;
}

/**
 * Returns a ready signer for the hardware id, reusing a matching one. Concurrent
 * callers share a single preparation; the setup exchange rides the wisp tunnel.
 */
export async function prepareSigner(
  hardwareID: string,
  endpoints: SapEndpoints,
): Promise<SapSigner> {
  if (
    prepared &&
    prepared.hardwareID === hardwareID &&
    endpointsEqual(prepared.endpoints, endpoints)
  ) {
    return prepared.signer;
  }
  if (preparation) {
    const underway = await preparation.catch(() => null);
    if (
      underway &&
      underway.hardwareID === hardwareID &&
      endpointsEqual(underway.endpoints, endpoints)
    ) {
      return underway.signer;
    }
  }

  preparation = runPreparation(hardwareID, endpoints);
  try {
    return (await preparation).signer;
  } finally {
    preparation = null;
  }
}

async function runPreparation(
  hardwareID: string,
  endpoints: SapEndpoints,
): Promise<PreparedSigner> {
  useSapStore.getState().begin(hardwareID);

  const previous = prepared;
  prepared = null;
  let driver: WorkerMachineDriver | null = null;
  try {
    // Tear down the old signer first: the worker holds ~160 MB of wasm heap.
    await previous?.driver.close().catch(() => undefined);

    const assets = await loadSapAssets((loaded, total) =>
      useSapStore
        .getState()
        .setAssets(total ? Math.round((loaded / total) * 100) : 0),
    );
    useSapStore.getState().setSetup();

    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    // A wedged worker must not outlive the attempt that found it, or the cached
    // signer keeps being handed back and every retry waits out another timeout.
    const wedged = new WorkerMachineDriver(worker, () => {
      if (prepared?.driver === wedged) prepared = null;
      wedged.terminate();
    });
    driver = wedged;
    const wasm = await loadWorkerWasmBinary();
    await wedged.open(assets, wasm);

    const signer = await SapSigner.create(
      {
        ...endpoints,
        hardwareID: new TextEncoder().encode(hardwareID),
        assets,
      },
      wedged,
      {
        fetchCertificate: () => fetchSetupCertificate(endpoints),
        exchange: (input) => exchangeSetupBuffer(endpoints, input),
      },
    );

    const result = { signer, driver: wedged, hardwareID, endpoints };
    prepared = result;
    useSapStore.getState().setReady();
    return result;
  } catch (error) {
    // The worker holds ~160 MB of wasm heap and nothing outside this function
    // can reach it once preparation is called off (a transient Apple 502 on the
    // setup exchange suffices). Left running, each retry would add another one.
    driver?.terminate();
    useSapStore
      .getState()
      .setError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Signs body bytes, preparing the signer on demand. */
export async function signWithSap(
  hardwareID: string,
  endpoints: SapEndpoints,
  body: Uint8Array,
): Promise<string> {
  const signer = await prepareSigner(hardwareID, endpoints);
  return signer.sign(body);
}

function endpointsEqual(left: SapEndpoints, right: SapEndpoints): boolean {
  return (
    left.certificateURL === right.certificateURL &&
    left.setupURL === right.setupURL &&
    left.version === right.version
  );
}
