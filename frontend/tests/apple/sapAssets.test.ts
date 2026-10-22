import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The asset module talks to the Cache API and crypto directly. These tests keep
// the real module and replace only those browser facilities, so the parallel
// fan-out and progress bookkeeping are exercised as shipped.
const names = [
  "CommerceKit",
  "CommerceCore",
  "CoreFP",
  "CoreFP.icxs",
  "StoreAgent",
] as const;

let assets: typeof import("../../src/apple/sap/assets");
let cache: Map<string, Uint8Array<ArrayBuffer>>;
let fetchMock: ReturnType<typeof vi.fn>;
let digestMock: ReturnType<typeof vi.spyOn>;

function bytes(size: number, seed: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).fill(seed);
}

function responseFor(data: Uint8Array<ArrayBuffer>): Response {
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data.subarray(0, Math.ceil(data.length / 2)));
      controller.enqueue(data.subarray(Math.ceil(data.length / 2)));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Length": String(data.length) },
  });
}

beforeEach(async () => {
  vi.resetModules();
  cache = new Map();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("caches", {
    open: vi.fn(async () => ({
      match: vi.fn(async (url: string) => {
        const data = cache.get(url);
        return data ? new Response(data) : undefined;
      }),
      put: vi.fn(async (url: string, response: Response) => {
        cache.set(url, new Uint8Array(await response.arrayBuffer()));
      }),
    })),
    delete: vi.fn(async () => true),
  });
  assets = await import("../../src/apple/sap/assets");
  // The fixtures are cheap fill bytes, not copies of Apple's binaries. Map
  // each pinned size to its expected digest so the real digestMatches path
  // still runs and a wrong-sized response would still fail.
  digestMock = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(
    async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const size = data.byteLength;
      const spec = assets.SAP_ASSET_SPECS.find(
        (candidate) => candidate.size === size,
      )!;
      return Uint8Array.from(
        spec.sha256.match(/../g)!.map((byte) => parseInt(byte, 16)),
      ).buffer;
    },
  );
});

afterEach(() => {
  digestMock.mockRestore();
  vi.unstubAllGlobals();
});

describe("loadSapAssets", () => {
  it("starts all five downloads before waiting for any one of them", async () => {
    const resolvers = new Map<string, (value: Response) => void>();
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          resolvers.set(url, resolve);
        }),
    );

    const loading = assets.loadSapAssets();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    for (const [index, name] of names.entries()) {
      const data = bytes(assets.SAP_ASSET_SPECS[index].size, index + 1);
      resolvers.get(`/api/sap-assets/${name}`)!(responseFor(data));
    }
    await loading;
  });

  it("reports raw-byte progress across concurrently decoded bodies", async () => {
    const progress: Array<[number, number]> = [];
    const total = assets.SAP_ASSET_SPECS.reduce(
      (sum, spec) => sum + spec.size,
      0,
    );
    fetchMock.mockImplementation((url: string) => {
      const spec = assets.SAP_ASSET_SPECS.find((candidate) =>
        url.endsWith(candidate.name),
      )!;
      return Promise.resolve(responseFor(bytes(spec.size, 1)));
    });

    await assets.loadSapAssets((loaded, totalBytes) => {
      progress.push([loaded, totalBytes]);
    });

    expect(progress.length).toBeGreaterThan(5);
    expect(progress.every(([, reported]) => reported === total)).toBe(true);
    expect(progress.at(-1)).toEqual([total, total]);
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index][0]).toBeGreaterThanOrEqual(progress[index - 1][0]);
    }
  });

  it("uses cached assets without a network request", async () => {
    for (const [index, spec] of assets.SAP_ASSET_SPECS.entries()) {
      const data = bytes(spec.size, index + 1);
      cache.set(`/api/sap-assets/${spec.name}`, data);
    }

    const bundle = await assets.loadSapAssets();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bundle.coreFP.length).toBe(14_904_192);
  });

  it("stops progress and aborts peers after the first failure", async () => {
    const signals = new Map<string, AbortSignal>();
    const progress: number[] = [];
    fetchMock.mockImplementation(
      (url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signals.set(url, init.signal!);
          if (url.endsWith("CommerceCore")) {
            queueMicrotask(() => reject(new Error("boom")));
            return;
          }
          init.signal!.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    await expect(
      assets.loadSapAssets((loaded) => progress.push(loaded)),
    ).rejects.toThrow("boom");

    expect(signals.size).toBe(5);
    expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect(progress).toEqual([]);
  });
});
