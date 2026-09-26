import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ChunkedDownloader,
  readPartSizes,
  removePartFiles,
} from "../src/services/chunkedDownloader.js";

const TEMP_DIR = path.join(os.tmpdir(), "chunked-downloader-test");

beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function destPath(name: string): string {
  return path.join(TEMP_DIR, name, "package.ipa");
}

function writeParts(target: string, sizes: number[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  sizes.forEach((size, index) => {
    fs.writeFileSync(`${target}.part${index}`, Buffer.alloc(size));
  });
}

describe("readPartSizes", () => {
  it("reports the size of each part file, 0 for missing ones", () => {
    const target = destPath("read-sizes");
    writeParts(target, [100, 200]);

    expect(readPartSizes(target, 3)).toEqual([100, 200, 0]);
  });

  it("returns zeroes when no parts exist", () => {
    const target = destPath("read-sizes-empty");
    fs.mkdirSync(path.dirname(target), { recursive: true });

    expect(readPartSizes(target, 2)).toEqual([0, 0]);
  });
});

describe("removePartFiles", () => {
  it("removes only the .part siblings of the destination", () => {
    const target = destPath("remove-parts");
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${target}.part0`, Buffer.alloc(10));
    fs.writeFileSync(`${target}.part1`, Buffer.alloc(20));
    fs.writeFileSync(target, Buffer.alloc(5));
    const unrelated = path.join(dir, "other.ipa.part0");
    fs.writeFileSync(unrelated, Buffer.alloc(10));

    removePartFiles(target);

    expect(fs.existsSync(`${target}.part0`)).toBe(false);
    expect(fs.existsSync(`${target}.part1`)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

describe("ChunkedDownloader.abort", () => {
  it("keeps .part files when asked (pause/resume)", () => {
    const target = destPath("abort-keep");
    writeParts(target, [50, 60]);
    const downloader = new ChunkedDownloader("https://example.com/x", target);

    downloader.abort(true);

    expect(fs.existsSync(`${target}.part0`)).toBe(true);
    expect(fs.existsSync(`${target}.part1`)).toBe(true);
  });

  it("removes .part files by default (delete/timeout)", () => {
    const target = destPath("abort-clean");
    writeParts(target, [50, 60]);
    const downloader = new ChunkedDownloader("https://example.com/x", target);

    downloader.abort();

    expect(fs.existsSync(`${target}.part0`)).toBe(false);
    expect(fs.existsSync(`${target}.part1`)).toBe(false);
  });
});

/**
 * The downloader over a stubbed CDN. The server answers the HEAD the probe makes
 * and then serves the body it is given for each `Range`, which is the whole
 * exchange a real one has.
 */
describe("ChunkedDownloader.download", () => {
  /** 300 distinct bytes, so a merge that reorders or truncates is visible. */
  const source = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 251));

  /** A one-shot body, so the stream's length is independent of any header. */
  function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A destination inside a directory that exists. The downloader writes beside
   * the file it is given and assumes that directory is there — the pipeline
   * that owns a task creates it before the transfer starts.
   */
  function preparedDest(name: string): string {
    const target = destPath(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }

  function serve(options: { ranges?: boolean; body?: Buffer; declared?: number }) {
    const body = options.body ?? source;
    const declared = options.declared ?? source.length;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(declared),
            ...(options.ranges === false ? {} : { "accept-ranges": "bytes" }),
          },
        });
      }

      const range = /bytes=(\d+)-(\d+)/.exec(
        String((init?.headers as Record<string, string> | undefined)?.Range ?? ""),
      );
      if (!range) {
        // The whole-file answer. Its header states `declared` while the stream
        // carries whatever `body` holds — which is how a transfer that stops
        // early looks, and the case the size check exists for.
        return new Response(streamOf(body), {
          status: 200,
          headers: { "content-length": String(declared) },
        });
      }

      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      const slice = body.subarray(start, Math.max(end + 1, start));
      return new Response(streamOf(slice), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("assembles the chunks into the whole file and clears the parts", async () => {
    const target = preparedDest("download-complete");
    serve({});

    await new ChunkedDownloader("https://example.com/app.ipa", target, {
      threads: 3,
    }).download(new AbortController().signal);

    expect(fs.readFileSync(target).equals(source)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(fs.existsSync(`${target}.part${i}`)).toBe(false);
    }
  });

  it("refuses a chunk that answered short, and leaves no package behind", async () => {
    // Nothing else notices: a short chunk ends its stream normally, so the part
    // is written, the merge succeeds and the file is simply too small.
    const target = preparedDest("download-short-chunk");
    // Two chunks of 150; the second one stops 100 bytes early.
    const short = source.subarray(0, 200);
    serve({ body: short });

    await expect(
      new ChunkedDownloader("https://example.com/app.ipa", target, {
        threads: 2,
      }).download(new AbortController().signal),
    ).rejects.toThrow(/not the 300 Apple announced/);

    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses a single-stream transfer that ended early", async () => {
    const target = preparedDest("download-short-stream");
    // No `accept-ranges`, so the downloader falls back to one stream — and the
    // body stops after a third of what the header promised.
    serve({ ranges: false, body: source.subarray(0, 100) });

    await expect(
      new ChunkedDownloader("https://example.com/app.ipa", target).download(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not the 300 Apple announced/);

    expect(fs.existsSync(target)).toBe(false);
  });
});
