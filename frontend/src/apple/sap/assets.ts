// SAP asset delivery: the five Apple binaries (CoreFP, CoreFP.icxs,
// CommerceKit, CommerceCore, StoreAgent) are extracted once by the backend from a public
// Apple software update package and served from /api/sap-assets. The browser
// caches them in the Cache API keyed by their pinned SHA-256 digests.

import { authHeaders } from "../../api/client";
import type { SapAssetBundle } from "./types";

export interface SapAssetSpec {
  name: string;
  /** Size/digest of the distributed (backend-stripped) x86_64 file. */
  size: number;
  sha256: string;
}

/**
 * Digests of the distributed assets; the backend strips fat binaries to their
 * x86_64 slice (the emulated guest architecture) after verifying Apple's pins.
 * See backend/src/services/sapAssets.ts for both pin sets.
 */
export const SAP_ASSET_SPECS: SapAssetSpec[] = [
  {
    name: "CommerceKit",
    size: 3271840,
    sha256: "b84ff12c21987856c0a17b78f1ad82b73195a6dec5f3b208a17d245555a2c8a2",
  },
  {
    name: "CommerceCore",
    size: 115712,
    sha256: "05707cd937798f2b5189471f513672ac6242ffbffc38f06ed2e4fb4345156819",
  },
  {
    name: "CoreFP",
    size: 14904192,
    sha256: "97c899f2fb076bdf7f810fe00ceb335d4af85efab0f2de737ad0aedd991c8277",
  },
  {
    name: "CoreFP.icxs",
    size: 5288352,
    sha256: "473e78af86979f5bd4f6269561caf770b3d16c098d918846eeac8cdd2fe6566a",
  },
  {
    name: "StoreAgent",
    size: 2580176,
    sha256: "70ce036f9dbcbc04db9511ebd08de0dd3cbc35ccc9d44b089c90170cb5453c59",
  },
];

// v2 adds StoreAgent. A v1 cache has the old four files; reusing that name would
// leave every user downloading the fifth asset separately on first kbsync use.
const CACHE_NAME = "asspp-sap-assets-v2";

async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { headers: authHeaders(), signal });
  if (!response.ok) {
    throw new Error(`SAP asset download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const assembled = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    assembled.set(chunk, offset);
    offset += chunk.length;
  }
  return assembled;
}

async function digestMatches(
  data: Uint8Array<ArrayBuffer>,
  expected: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  const actual = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return actual === expected;
}

function aborted(): DOMException {
  return new DOMException("SAP asset download cancelled", "AbortError");
}

/**
 * Loads all five SAP assets in parallel, verifying digests. Bytes come from the
 * backend cache (public Apple data) and are persisted in the Cache API so the
 * transfer happens once.
 */
export async function loadSapAssets(
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<SapAssetBundle> {
  const totalBytes = SAP_ASSET_SPECS.reduce((sum, spec) => sum + spec.size, 0);
  const controller = new AbortController();
  let failed = false;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    // Cache API unavailable (private mode); fall back to direct downloads.
  }

  // Network transfer is compressed, so Content-Length is not the raw asset size.
  // Keep one counter per asset and report the sum of raw progress, clamped to
  // the pinned total. Each asset starts at its cached size when already present.
  const progress = new Map<string, number>();
  const reportProgress = () => {
    if (failed) return;
    const loaded = SAP_ASSET_SPECS.reduce(
      (sum, spec) => sum + Math.min(progress.get(spec.name) ?? 0, spec.size),
      0,
    );
    onProgress?.(loaded, totalBytes);
  };

  async function loadOne(spec: SapAssetSpec): Promise<Uint8Array<ArrayBuffer>> {
    if (failed) throw aborted();
    let data: Uint8Array<ArrayBuffer> | null = null;

    if (cache) {
      const cached = await cache.match(`/api/sap-assets/${spec.name}`);
      if (cached) {
        const cachedBytes = new Uint8Array(await cached.arrayBuffer());
        if (await digestMatches(cachedBytes, spec.sha256)) {
          // Hand out the verified view directly; a copy doubled peak memory for nothing.
          data = cachedBytes;
          progress.set(spec.name, spec.size);
          reportProgress();
        }
      }
    }

    if (!data) {
      if (failed) throw aborted();
      data = await fetchWithProgress(
        `/api/sap-assets/${spec.name}`,
        (loaded) => {
          // The response body is decoded by the browser; its length is the raw
          // size. The denominator below is also raw, so progress stays honest
          // even though Brotli made the bytes on the wire smaller.
          progress.set(spec.name, Math.min(loaded, spec.size));
          reportProgress();
        },
        controller.signal,
      );
      if (!(await digestMatches(data, spec.sha256))) {
        throw new Error(`SAP asset ${spec.name} failed integrity verification`);
      }
      if (failed) throw aborted();
      if (cache) {
        const copy = new Uint8Array(data);
        await cache.put(
          `/api/sap-assets/${spec.name}`,
          new Response(copy.buffer as ArrayBuffer, {
            headers: { "Content-Type": "application/octet-stream" },
          }),
        );
      }
      progress.set(spec.name, spec.size);
      reportProgress();
    }

    return data;
  }

  // The five files are independent and the browser can multiplex them over one
  // HTTP/2 connection. Starting them together hides the per-file round trips a
  // sequential loop paid; it does not change the total bytes downloaded.
  const requests = SAP_ASSET_SPECS.map(loadOne);
  let results: Uint8Array<ArrayBuffer>[];
  try {
    results = await Promise.all(requests);
  } catch (error) {
    failed = true;
    controller.abort();
    // Promise.all rejects on the first failure while the other fetches are
    // still unwinding. Wait for all five so no late writer reaches the cache
    // after the caller has moved on.
    await Promise.allSettled(requests);
    throw error;
  }
  const bundle: Record<string, Uint8Array> = {};
  for (let index = 0; index < SAP_ASSET_SPECS.length; index++) {
    bundle[SAP_ASSET_SPECS[index].name] = results[index];
  }

  return {
    commerceKit: bundle["CommerceKit"],
    commerceCore: bundle["CommerceCore"],
    coreFP: bundle["CoreFP"],
    coreFPICXS: bundle["CoreFP.icxs"],
    storeAgent: bundle["StoreAgent"],
  };
}

/** Drops the cached assets (used after a digest pin update). */
export async function clearSapAssets(): Promise<void> {
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // ignore
  }
}
