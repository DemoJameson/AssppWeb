import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import zlib from "node:zlib";

const RAW = Buffer.alloc(100_000, 7);
const DIGEST = "a".repeat(64);

vi.mock("../src/services/sapAssets.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/services/sapAssets.js")
  >();
  return {
    ...original,
    SAP_ASSET_SPECS: [
      {
        name: "CoreFP",
        strippedSize: RAW.length,
        strippedSha256: DIGEST,
      },
    ],
    ensureSapAssets: vi.fn(async () => undefined),
    readCachedAsset: vi.fn(async () => RAW),
    readBrotliSidecar: vi.fn(async () =>
      zlib.brotliCompressSync(RAW, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    ),
  };
});

const route = (await import("../src/routes/sapAssets.js")).default;

function app() {
  const instance = express();
  instance.use("/api", route);
  return instance;
}

function assetURL(): string {
  return `/api/sap-assets/CoreFP?sha256=${DIGEST}`;
}

describe("SAP asset route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers a precompressed Brotli body when the client accepts it", async () => {
    const res = await request(app())
      .get(assetURL())
      .set("Accept-Encoding", "br, gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers.etag).toContain("-br");
    // Supertest decodes Content-Encoding before exposing `body`, just as a
    // browser does. The header still proves which representation was sent.
    expect(Buffer.from(res.body).equals(RAW)).toBe(true);
  });

  it("falls back to gzip when Brotli is accepted but no sidecar exists", async () => {
    const assets = await import("../src/services/sapAssets.js");
    vi.mocked(assets.readBrotliSidecar).mockResolvedValueOnce(null);

    const res = await request(app())
      .get(assetURL())
      .set("Accept-Encoding", "br, gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(Buffer.from(res.body).equals(RAW)).toBe(true);
  });

  it("honours q-values when choosing between br and gzip", async () => {
    const res = await request(app())
      .get(assetURL())
      .set("Accept-Encoding", "br;q=0.1, gzip;q=1");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("honours q=0 and returns the raw bytes when no encoding is accepted", async () => {
    const res = await request(app())
      .get(assetURL())
      .set("Accept-Encoding", "br;q=0, gzip;q=0");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.equals(RAW)).toBe(true);
  });

  it("never labels raw bytes as Brotli for a Brotli-only client", async () => {
    const assets = await import("../src/services/sapAssets.js");
    vi.mocked(assets.readBrotliSidecar).mockResolvedValueOnce(null);

    const res = await request(app())
      .get(assetURL())
      .set("Accept-Encoding", "br");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.equals(RAW)).toBe(true);
  });

  it("refuses a request whose digest does not name the pinned bytes", async () => {
    const res = await request(app()).get(
      `/api/sap-assets/CoreFP?sha256=${"b".repeat(64)}`,
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "SAP asset digest does not match" });
  });

  it("refuses a request without a digest", async () => {
    const res = await request(app()).get("/api/sap-assets/CoreFP");

    expect(res.status).toBe(409);
  });
});
