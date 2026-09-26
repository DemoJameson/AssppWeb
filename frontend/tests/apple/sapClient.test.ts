import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The signer's own modules are mocked: `./protocol` reaches libcurl (which does
// not run under jsdom) and `./assets` would try to download 14 MB. Everything
// else — the driver, its timeouts, the signer's setup sequence, the cached
// preparation — is the real thing.
vi.mock("../../src/apple/sap/protocol", () => ({
  fetchSetupCertificate: vi.fn(async () => new Uint8Array([1])),
  exchangeSetupBuffer: vi.fn(async () => new Uint8Array([2])),
}));
vi.mock("../../src/apple/sap/assets", () => ({
  loadSapAssets: vi.fn(),
}));

// The prepared signer is module state, so every test gets its own copy of the
// client (and of the mocks it holds).
type Client = typeof import("../../src/apple/sap/client");
type Assets = typeof import("../../src/apple/sap/assets");
type Protocol = typeof import("../../src/apple/sap/protocol");
type Store = typeof import("../../src/store/sap");

let client: Client;
let assets: Assets;
let protocol: Protocol;
let store: Store;

const ENDPOINTS = {
  certificateURL: "https://s.mzstatic.com/sap/cert",
  setupURL: "https://s.mzstatic.com/sap/setup",
  version: 200,
};

const ASSETS = {
  commerceKit: new Uint8Array([1]),
  commerceCore: new Uint8Array([1]),
  coreFP: new Uint8Array([1]),
  coreFPICXS: new Uint8Array([1]),
};

/**
 * Stands in for the Web Worker: answers whatever the test lets it answer, and
 * records that it was terminated. Replies arrive on a microtask, the way a real
 * worker's do.
 */
class StubWorker {
  static readonly created: StubWorker[] = [];
  /** Request types the worker refuses to answer at all. */
  static silent = new Set<string>();
  /** Request types the worker answers with an error. */
  static failing = new Set<string>();

  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private exchanges = 0;

  constructor() {
    StubWorker.created.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    const type = String(message.type);
    if (StubWorker.silent.has(type)) return;

    if (StubWorker.failing.has(type)) {
      queueMicrotask(() =>
        this.onmessage?.({
          data: { type: "error", id: message.id, message: `${type} failed` },
        }),
      );
      return;
    }

    // The signer expects the setup exchange to enter state 1 and leave it in 0.
    const reply =
      type === "exchange"
        ? {
            output: new Uint8Array([3]).buffer,
            state: ++this.exchanges === 1 ? 1 : 0,
          }
        : {
            open: {},
            initialize: { contextValue: 7 },
            sign: { signature: new Uint8Array([9]).buffer },
            teardown: {},
            close: {},
          }[type] ?? {};

    queueMicrotask(() =>
      this.onmessage?.({ data: { type: "result", id: message.id, ...reply } }),
    );
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(async () => {
  vi.resetModules();
  StubWorker.created.length = 0;
  StubWorker.silent = new Set();
  StubWorker.failing = new Set();
  vi.stubGlobal("Worker", StubWorker);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })),
  );

  const i18n = (await import("../../src/i18n")).default;
  await i18n.changeLanguage("en-US");

  assets = await import("../../src/apple/sap/assets");
  vi.mocked(assets.loadSapAssets).mockResolvedValue(ASSETS);

  protocol = await import("../../src/apple/sap/protocol");
  vi.mocked(protocol.exchangeSetupBuffer).mockResolvedValue(
    new Uint8Array([2]),
  );

  store = await import("../../src/store/sap");
  client = await import("../../src/apple/sap/client");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sap signer client", () => {
  it("prepares a signer that signs through the worker", async () => {
    const signer = await client.prepareSigner("aabbccddeeff", ENDPOINTS);
    await expect(signer.sign(new Uint8Array([1]))).resolves.toBe("CQ==");

    expect(StubWorker.created).toHaveLength(1);
    expect(store.useSapStore.getState().stage).toBe("ready");
  });

  it("reuses the prepared signer for the same account", async () => {
    await client.prepareSigner("aabbccddeeff", ENDPOINTS);
    await client.prepareSigner("aabbccddeeff", ENDPOINTS);

    // Rebuilding means copying the 22.5 MB asset bundle into a fresh worker
    // again; a 2FA retry must not pay that.
    expect(StubWorker.created).toHaveLength(1);
  });

  it("drops the worker when the setup exchange fails", async () => {
    // Apple answering 502 on the setup exchange is enough to get here.
    vi.mocked(protocol.exchangeSetupBuffer).mockRejectedValue(
      new Error("SAP setup exchange returned 502"),
    );

    await expect(
      client.prepareSigner("aabbccddeeff", ENDPOINTS),
    ).rejects.toThrow("returned 502");

    expect(StubWorker.created).toHaveLength(1);
    expect(StubWorker.created[0].terminated).toBe(true);
    expect(store.useSapStore.getState().stage).toBe("error");
  });

  it("drops the worker when the emulation cannot even be loaded", async () => {
    StubWorker.failing = new Set(["open"]);

    // That worker holds ~160 MB of wasm heap and nothing outside the
    // preparation can reach it, so a failure here may not leave one running.
    await expect(
      client.prepareSigner("aabbccddeeff", ENDPOINTS),
    ).rejects.toThrow("open failed");

    expect(StubWorker.created[0].terminated).toBe(true);
  });

  it("gives up on a worker that stops answering instead of waiting for ever", async () => {
    vi.useFakeTimers();
    // Wedged inside the setup exchange: nothing the signer does comes back.
    StubWorker.silent = new Set(["initialize"]);

    const pending = client
      .prepareSigner("aabbccddeeff", ENDPOINTS)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(client.SAP_CALL_TIMEOUT_MS);
    const error = (await pending) as Error;

    // Nothing else bounds these calls — the Apple request they sign for comes
    // later and has its own timeout, which never sees them.
    expect(error.message).toMatch(/signing component/i);
    expect(StubWorker.created[0].terminated).toBe(true);
    expect(store.useSapStore.getState().error).toMatch(/signing component/i);
  });

  it("bounds a signing call and rebuilds instead of reusing the dead worker", async () => {
    vi.useFakeTimers();
    await client.prepareSigner("aabbccddeeff", ENDPOINTS);

    StubWorker.silent = new Set(["sign"]);
    const signing = client
      .signWithSap("aabbccddeeff", ENDPOINTS, new Uint8Array([1]))
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(client.SAP_CALL_TIMEOUT_MS);

    expect(((await signing) as Error).message).toMatch(/signing component/i);
    expect(StubWorker.created[0].terminated).toBe(true);

    // The next attempt must get a new worker: handing back the wedged one would
    // cost it another two minutes for an answer that cannot come.
    StubWorker.silent = new Set();
    const signer = await client.prepareSigner("aabbccddeeff", ENDPOINTS);
    await expect(signer.sign(new Uint8Array([1]))).resolves.toBe("CQ==");

    expect(StubWorker.created).toHaveLength(2);
    expect(StubWorker.created[1].terminated).toBe(false);
  });
});
