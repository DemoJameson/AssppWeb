import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RAW = Buffer.alloc(70_000, 3);
const STALE = Buffer.alloc(70_000, 4);
const PIN = createHash("sha256").update(RAW).digest("hex");

let temp: string;
let dataDir: string;
let bundledDir: string;
let service: typeof import("../src/services/sapAssets.js");

beforeEach(async () => {
  vi.resetModules();
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "sap-assets-service-"));
  dataDir = path.join(temp, "data");
  bundledDir = path.join(temp, "bundled");
  process.env.DATA_DIR = dataDir;
  process.env.BUNDLED_SAP_ASSETS = bundledDir;
  await fs.mkdir(path.join(dataDir, "sap-assets"), { recursive: true });
  await fs.mkdir(bundledDir, { recursive: true });
  service = await import("../src/services/sapAssets.js");
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.BUNDLED_SAP_ASSETS;
  await fs.rm(temp, { recursive: true, force: true });
});

function oneAsset() {
  service.SAP_ASSET_SPECS.splice(0, service.SAP_ASSET_SPECS.length, {
    name: "CoreFP",
    archivePath: "CoreFP",
    size: RAW.length,
    sha256: PIN,
    strippedSize: RAW.length,
    strippedSha256: PIN,
  });
}

describe("SAP asset service", () => {
  it("replaces a stale sidecar instead of serving it forever", async () => {
    const assets = path.join(dataDir, "sap-assets");
    await fs.writeFile(path.join(assets, "CoreFP"), RAW);
    await fs.writeFile(
      path.join(assets, "CoreFP.br"),
      zlib.brotliCompressSync(STALE),
    );
    await fs.writeFile(
      path.join(bundledDir, "CoreFP.br"),
      zlib.brotliCompressSync(RAW),
    );

    // The service reads the exported specs at call time, so this test uses a
    // synthetic one-asset set with the fixture's digest.
    oneAsset();

    const sidecar = await service.readBrotliSidecar("CoreFP");

    expect(sidecar).not.toBeNull();
    expect(zlib.brotliDecompressSync(sidecar!)).toEqual(RAW);
    expect(
      zlib.brotliDecompressSync(
        await fs.readFile(path.join(assets, "CoreFP.br")),
      ),
    ).toEqual(RAW);
  });

  it("shares one preparation among concurrent cold-start requests", async () => {
    oneAsset();
    await fs.writeFile(path.join(bundledDir, "CoreFP"), RAW);

    const first = service.ensureSapAssets();
    const second = service.ensureSapAssets();
    const third = service.ensureSapAssets();

    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    expect(await fs.readFile(path.join(dataDir, "sap-assets", "CoreFP"))).toEqual(
      RAW,
    );
  });
});
