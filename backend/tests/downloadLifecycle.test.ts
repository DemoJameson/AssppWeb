import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Software } from "../src/types/index.js";

// The manager decides where a task lands from `config.dataDir`, read once at
// import time — so the scratch directory has to exist first (same shape as the
// other store tests).
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-download-"));
process.env.DATA_DIR = TEMP_DIR;
process.env.DOWNLOAD_THREADS = "2";

// The real decrypter is a separate binary built into the image; what these
// tests are about is when it runs and what its answer does to the task, so it
// is stood in for here. The package it is handed is Apple's ciphertext either
// way (see `ciphertextPayload`).
const decrypt = vi.hoisted(() => vi.fn());
vi.mock("../src/services/macDecrypt.js", () => ({
  decryptMacOSPackage: decrypt,
}));

const manager = await import("../src/services/downloadManager.js");

const URL = "https://iosapps.apple.com/assets/example.pkg";
const ACCOUNT_HASH = "a".repeat(64);

/** What a macOS task needs to be decrypted; the backend refuses one without. */
const DECRYPTION = { dpInfo: "AA==", hardwareId: "345a6045423b" };

function software(overrides: Partial<Software> = {}): Software {
  return {
    id: 6443975850,
    bundleID: "com.example.player",
    name: "Example Player",
    version: "6.2.1",
    artistName: "",
    sellerName: "",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "",
    releaseDate: "",
    primaryGenreName: "",
    platform: "macos",
    externalVersionId: "890964839",
    ...overrides,
  };
}

/** A `xar` container's first bytes; the rest only has to be bytes. */
function xarPayload(size = 64 * 1024): Buffer {
  return Buffer.concat([
    Buffer.from("xar!\x00\x1c\x00\x01", "latin1"),
    Buffer.alloc(size, 3),
  ]);
}

/**
 * What Apple serves a macOS task: still FairPlay ciphertext, so neither magic
 * this pipeline knows. The head is the one the instance actually stored.
 */
function ciphertextPayload(size = 64 * 1024): Buffer {
  return Buffer.concat([
    Buffer.from([0xba, 0x6b, 0x39, 0xe3]),
    Buffer.alloc(size, 9),
  ]);
}

let taskId = "";

let chunkRequests = 0;

/**
 * A CDN that answers like Apple's does: a HEAD probe advertising byte ranges,
 * then one 206 per requested range. `drip` hands the body out in small pieces
 * so a test can catch the transfer in flight.
 */
function serve(payload: Buffer, options: { drip?: boolean } = {}): void {
  vi.stubGlobal(
    "fetch",
    async (_input: unknown, init?: RequestInit & { headers?: Record<string, string> }) => {
      const range = init?.headers?.Range;

      if (init?.method === "HEAD" || !range) {
        return new Response(null, {
          status: 200,
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(payload.length),
          },
        });
      }

      chunkRequests++;
      const [start, end] = range.replace("bytes=", "").split("-").map(Number);
      const slice = payload.subarray(start, end + 1);

      if (!options.drip) {
        return new Response(slice, {
          status: 206,
          headers: { "content-length": String(slice.length) },
        });
      }

      const signal = init.signal ?? undefined;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new Error("aborted"));
            return;
          }
          if (offset >= slice.length) {
            controller.close();
            return;
          }
          controller.enqueue(slice.subarray(offset, offset + 4096));
          offset += 4096;
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      });

      return new Response(body, { status: 206 });
    },
  );
}

/** Waits for a task to stop moving, then hands back whatever it settled as. */
async function settle(id: string) {
  const deadline = Date.now() + 15_000;
  const active = ["pending", "downloading", "injecting", "paused"];
  let task = manager.getTask(id);

  while (task && active.includes(task.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    task = manager.getTask(id);
  }

  return task;
}

/**
 * Waits for `check`, failing rather than passing on a silent timeout: a test
 * that needed the condition would otherwise run on without exercising it (the
 * race below is only a race if the first attempt is really mid-transfer).
 */
async function waitUntil(
  check: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

const created: string[] = [];

/**
 * Creates the task a test works on and remembers its id: the decrypter
 * stand-in looks the task up while it runs, to see what the row would show.
 */
function startTask(): string {
  const task = manager.createTask(
    software(),
    ACCOUNT_HASH,
    URL,
    [],
    undefined,
    DECRYPTION,
  );
  created.push(task.id);
  taskId = task.id;
  return task.id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  chunkRequests = 0;
  decrypt.mockReset();
  for (const id of created.splice(0)) manager.deleteTask(id);
});

afterAll(async () => {
  // The scratch DB must be closed before its directory goes: SQLite keeps the
  // handle open a moment past `close()` otherwise, and `fs.rmSync` would EBUSY
  // (the same dance the other store tests do).
  const { closeDb } = await import("../src/services/db.js");
  closeDb();
  fs.rmSync(TEMP_DIR, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("download lifecycle", () => {
  beforeEach(() => {
    decrypt.mockReset();
  });

  it("leaves a macOS download Apple served unencrypted alone", async () => {
    // Apple sends a Mac download encrypted, but the pipeline does not assume
    // it: a file that already reads as a package is not decrypted again, which
    // would only corrupt it.
    const payload = xarPayload();
    serve(payload);

    const id = startTask();
    const settled = await settle(id);

    expect(settled?.status).toBe("completed");
    expect(settled?.hasFile).toBe(true);
    expect(settled?.progress).toBe(100);
    expect(decrypt).not.toHaveBeenCalled();
    expect(fs.statSync(settled!.filePath!).size).toBe(payload.length);
    expect(
      fs.readFileSync(settled!.filePath!, { encoding: "latin1" }).slice(0, 4),
    ).toBe("xar!");
  });

  it("decrypts what Apple served and keeps the package that comes out", async () => {
    serve(ciphertextPayload());
    const seen: { status?: string; progress?: number }[] = [];

    decrypt.mockImplementation(
      async ({
        filePath,
        onProgress,
      }: {
        filePath: string;
        onProgress?: (ratio: number) => void;
      }) => {
        // What the row shows while this runs: the transfer is over, and the
        // step that is left has its own progress to report.
        onProgress?.(0.25);
        seen.push({
          status: manager.getTask(taskId)?.status,
          progress: manager.getTask(taskId)?.progress,
        });
        fs.writeFileSync(filePath, xarPayload());
      },
    );

    const id = startTask();
    const settled = await settle(id);

    expect(settled?.status).toBe("completed");
    expect(settled?.progress).toBe(100);
    expect(seen).toEqual([{ status: "injecting", progress: 25 }]);
    // The package is decrypted in place, so what the task holds is the xar.
    expect(
      fs.readFileSync(settled!.filePath!, { encoding: "latin1" }).slice(0, 4),
    ).toBe("xar!");
    expect(decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: settled!.filePath,
        dpInfo: DECRYPTION.dpInfo,
        hardwareId: DECRYPTION.hardwareId,
      }),
    );
  });

  it("lands a failure that happens after the download instead of hanging at 100%", async () => {
    // The transfer is long over by the time the decrypter refuses a package,
    // and nothing else would ever move the task off `downloading` again — so
    // its reason has to reach the task, in its own words.
    serve(ciphertextPayload());
    decrypt.mockRejectedValue(
      new Error(
        "the macOS package could not be decrypted: decrypted package is not a xar archive (starts with 0x ba 6b 39 e3)",
      ),
    );

    const id = startTask();
    const settled = await settle(id);

    expect(settled?.status).toBe("failed");
    expect(settled?.error).toMatch(/could not be decrypted/);
    expect(settled?.error).toMatch(/ba 6b 39 e3/);
    // The task is terminal and nothing can retry it as-is, so the key material
    // does not sit in memory until the user deletes the row.
    expect(settled?.dpInfo).toBeUndefined();
    expect(settled?.hardwareId).toBeUndefined();
  });

  it("refuses what a decrypter hands back when it is still not a package", async () => {
    // The archive check still runs on the result: a decrypter that returns the
    // ciphertext unchanged must not leave a task that looks installable.
    const payload = ciphertextPayload();
    serve(payload);
    decrypt.mockImplementation(async ({ filePath }: { filePath: string }) => {
      fs.writeFileSync(filePath, payload);
    });

    const id = startTask();
    const settled = await settle(id);

    expect(settled?.status).toBe("failed");
    expect(settled?.error).toMatch(/not a Mac package/);
    expect(settled?.error).toMatch(/0xba6b39e3/);
  });

  it("refuses a macOS task that could not be decrypted afterwards", async () => {
    // Fetching a package nothing can open costs a user tens or hundreds of
    // megabytes, so the two pieces decryption needs are required at creation.
    serve(ciphertextPayload());

    expect(() =>
      manager.createTask(software(), ACCOUNT_HASH, URL, []),
    ).toThrow(/dpInfo/);

    expect(() =>
      manager.createTask(software(), ACCOUNT_HASH, URL, [], undefined, {
        dpInfo: "AA==",
        hardwareId: "not-hex",
      }),
    ).toThrow(/hardware id/);

    expect(decrypt).not.toHaveBeenCalled();
  });

  it("leaves a resumed task to the attempt that owns it", async () => {
    // A rapid pause → resume replaces the attempt's registration while the
    // first one is still unwinding. That attempt's failure must not land on the
    // task — the second attempt owns it now, and it finishes the download.
    serve(xarPayload(256 * 1024), { drip: true });

    const id = startTask();

    await waitUntil(() => chunkRequests > 0, "the first chunk request");
    expect(manager.getTask(id)?.status).toBe("downloading");

    manager.pauseTask(id);
    manager.resumeTask(id);

    const settled = await settle(id);

    expect(settled?.status).toBe("completed");
    expect(settled?.error).toBeUndefined();
  });

  it("keeps a paused task paused when the attempt it interrupted unwinds", async () => {
    // Pausing aborts the transfer, so the attempt that was running reports an
    // abort moments later — and that report must not land as this task's
    // failure, or pausing would read as a failed download.
    serve(xarPayload(256 * 1024), { drip: true });

    const id = startTask();

    await waitUntil(() => chunkRequests > 0, "the first chunk request");
    expect(manager.pauseTask(id)).toBe(true);

    // Room for the interrupted attempt to unwind before judging the status.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const paused = manager.getTask(id);
    expect(paused?.status).toBe("paused");
    expect(paused?.error).toBeUndefined();
  });

  it("keeps a pause that lands as the transfer ends", async () => {
    // The window this guards is the archive-magic read, which sits between the
    // transfer's end and the decryption step — the one place a pause used to be
    // overwritten by `injecting` and then unwind as a stale attempt, leaving a
    // row that no button could move again. The spy lands the pause inside that
    // read deterministically.
    serve(ciphertextPayload());
    decrypt.mockImplementation(async ({ filePath }: { filePath: string }) => {
      fs.writeFileSync(filePath, xarPayload());
    });

    const id = startTask();

    let landed = false;
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockImplementation(((...args: unknown[]) => {
        const [openPath] = args;
        if (!landed && String(openPath).endsWith(".pkg")) {
          landed = true;
          manager.pauseTask(id);
        }
        return (realOpen as (...openArgs: unknown[]) => unknown)(...args);
      }) as never);

    await waitUntil(() => landed, "the pause to land in the magic read");
    openSpy.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const paused = manager.getTask(id);
    expect(paused?.status).toBe("paused");
    expect(paused?.error).toBeUndefined();
    expect(decrypt).not.toHaveBeenCalled();

    // The row stays usable: resuming finishes the download and decrypts it.
    expect(manager.resumeTask(id)).toBe(true);
    const settled = await settle(id);
    expect(settled?.status).toBe("completed");
  });
});
