import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import {
  DOWNLOAD_THREADS,
  CHUNK_RETRY_COUNT,
  CHUNK_RETRY_DELAY_MS,
  MAX_DOWNLOAD_SIZE,
} from "../config.js";
import { fetchFollowingRedirects } from "../utils/redirectFetch.js";

interface ChunkRange {
  index: number;
  start: number;
  end: number; // inclusive
}

interface ProgressInfo {
  downloaded: number;
  total: number;
  speed: string;
}

type ProgressCallback = (info: ProgressInfo) => void;

/** Size of each `${destPath}.part${i}` on disk; 0 when the file is absent. */
export function readPartSizes(
  destPath: string,
  chunkCount: number,
): number[] {
  const sizes = new Array<number>(chunkCount).fill(0);
  for (let i = 0; i < chunkCount; i++) {
    const partPath = `${destPath}.part${i}`;
    try {
      if (fs.existsSync(partPath)) {
        sizes[i] = fs.statSync(partPath).size;
      }
    } catch {
      // Unreadable — treat as absent.
    }
  }
  return sizes;
}

/** Remove every `${destPath}.part*` sibling of the destination file. */
export function removePartFiles(destPath: string): void {
  try {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(base + ".part")) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Multi-threaded HTTP downloader using Range requests.
 * Falls back to single-stream when the server doesn't support Range.
 */
export class ChunkedDownloader {
  private readonly url: string;
  private readonly destPath: string;
  private readonly threads: number;
  private readonly onProgress?: ProgressCallback;

  private abortControllers = new Set<AbortController>();
  private aborted = false;
  private chunkBytes: number[] = [];
  private totalSize = 0;
  private lastProgressTime = 0;
  private lastProgressBytes = 0;

  constructor(
    url: string,
    destPath: string,
    options?: { threads?: number; onProgress?: ProgressCallback },
  ) {
    this.url = url;
    this.destPath = destPath;
    this.threads = options?.threads ?? DOWNLOAD_THREADS;
    this.onProgress = options?.onProgress;
  }

  /** Probe the server for Range support and content length. */
  private async probe(signal: AbortSignal): Promise<{
    supportsRange: boolean;
    contentLength: number;
  }> {
    const res = await fetchFollowingRedirects(this.url, {
      method: "HEAD",
      signal,
    });
    if (!res.ok) {
      throw new Error(`HEAD failed: HTTP ${res.status}`);
    }

    const acceptRanges = res.headers.get("accept-ranges");
    const contentLength = parseInt(
      res.headers.get("content-length") || "0",
      10,
    );
    const supportsRange = acceptRanges === "bytes" && contentLength > 0;

    return { supportsRange, contentLength };
  }

  /** Split total size into chunk ranges. */
  private splitChunks(totalSize: number): ChunkRange[] {
    const chunkSize = Math.ceil(totalSize / this.threads);
    const chunks: ChunkRange[] = [];
    for (let i = 0; i < this.threads; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      if (start > totalSize - 1) break;
      chunks.push({ index: i, start, end });
    }
    return chunks;
  }

  /** Download a single chunk with retries, writing to a .part file. */
  private async downloadChunk(
    chunk: ChunkRange,
    signal: AbortSignal,
  ): Promise<void> {
    const partPath = `${this.destPath}.part${chunk.index}`;
    const expectedBytes = chunk.end - chunk.start + 1;

    // A pause leaves completed .part files behind; a chunk that is already
    // fully on disk is skipped, which is what makes resume a resume.
    try {
      if (
        fs.existsSync(partPath) &&
        fs.statSync(partPath).size === expectedBytes
      ) {
        this.chunkBytes[chunk.index] = expectedBytes;
        return;
      }
    } catch {
      // Stat failed — fall through and re-download the chunk.
    }

    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < CHUNK_RETRY_COUNT; attempt++) {
      if (this.aborted) throw new Error("Aborted");

      const ac = new AbortController();
      this.abortControllers.add(ac);
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const res = await fetchFollowingRedirects(this.url, {
          signal: ac.signal,
          headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
        });

        if (res.status !== 206 && res.status !== 200) {
          throw new Error(`Chunk ${chunk.index}: HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error(`Chunk ${chunk.index}: no body`);
        }

        const ws = fs.createWriteStream(partPath);
        const reader = res.body.getReader();
        const chunkBytesRef = this.chunkBytes;
        const chunkIndex = chunk.index;
        let chunkDownloaded = 0;

        const readable = new Readable({
          async read() {
            try {
              const { done, value } = await reader.read();
              if (done) {
                this.push(null);
                return;
              }
              chunkDownloaded += value.byteLength;
              if (chunkDownloaded > expectedBytes * 2) {
                this.destroy(
                  new Error(`Chunk ${chunkIndex}: exceeded expected size`),
                );
                return;
              }
              chunkBytesRef[chunkIndex] = chunkDownloaded;
              this.push(Buffer.from(value));
            } catch (err) {
              this.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          },
        });

        await pipeline(readable, ws);
        return; // success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (lastErr.name === "AbortError" || this.aborted) throw lastErr;
        if (attempt < CHUNK_RETRY_COUNT - 1) {
          await new Promise((r) => setTimeout(r, CHUNK_RETRY_DELAY_MS));
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        this.abortControllers.delete(ac);
      }
    }

    throw lastErr ?? new Error(`Chunk ${chunk.index} failed after retries`);
  }

  /** Merge all .part files into the final destination. */
  private async mergeChunks(chunkCount: number): Promise<void> {
    const ws = fs.createWriteStream(this.destPath);
    for (let i = 0; i < chunkCount; i++) {
      const partPath = `${this.destPath}.part${i}`;
      // A chunk that answered with nothing at all leaves no file behind, and
      // reading it would fail with an ENOENT from inside the stream machinery —
      // a reason that says nothing about what went wrong.
      if (!fs.existsSync(partPath)) {
        ws.destroy();
        throw new Error(`chunk ${i} of ${chunkCount} produced no data`);
      }
      const rs = fs.createReadStream(partPath);
      await pipeline(rs, ws, { end: false });
    }
    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
    });

    await this.assertComplete();
    this.cleanPartFiles(chunkCount);
  }

  /**
   * Refuses a transfer that did not produce the whole file.
   *
   * Nothing else catches this. A chunk that answers with fewer bytes than the
   * range asked for ends its stream normally, so the part file is written,
   * `pipeline` resolves and the merge succeeds — the package would simply be
   * short, and a truncated IPA fails later as a package that cannot be read.
   * `Apple`'s own `content-length` from the HEAD is the size every part was
   * cut against, so it is what the assembled file has to match. A file that
   * does not is removed rather than left where a retry could resume from it.
   */
  private async assertComplete(): Promise<void> {
    if (this.totalSize <= 0) return;

    let actual: number;
    try {
      actual = fs.statSync(this.destPath).size;
    } catch (err) {
      throw new Error(
        `the downloaded file could not be measured: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    if (actual === this.totalSize) return;

    try {
      fs.unlinkSync(this.destPath);
    } catch {
      // Best effort: the error below is the one worth reporting.
    }
    throw new Error(
      `the download is ${actual} bytes, not the ${this.totalSize} Apple announced`,
    );
  }

  /** Remove .part temporary files. */
  private cleanPartFiles(chunkCount: number): void {
    for (let i = 0; i < chunkCount; i++) {
      const partPath = `${this.destPath}.part${i}`;
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /** Single-stream fallback download. */
  private async downloadSingleStream(signal: AbortSignal): Promise<void> {
    const res = await fetchFollowingRedirects(this.url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    if (!res.body) throw new Error("No response body");

    const contentLength = parseInt(
      res.headers.get("content-length") || "0",
      10,
    );
    if (contentLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(
        `File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_SIZE} byte limit`,
      );
    }

    this.totalSize = contentLength;
    let downloaded = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    const ws = fs.createWriteStream(this.destPath);
    const reader = res.body.getReader();

    const readable = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
            return;
          }
          downloaded += value.byteLength;
          if (downloaded > MAX_DOWNLOAD_SIZE) {
            this.destroy(new Error("Download exceeded maximum size"));
            return;
          }
          this.push(Buffer.from(value));
        } catch (err) {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    const progressInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTime;
      if (elapsed >= 500) {
        const bytesPerSec = ((downloaded - lastBytes) / elapsed) * 1000;
        lastTime = now;
        lastBytes = downloaded;
        this.onProgress?.({
          downloaded,
          total: this.totalSize,
          speed: formatSpeed(bytesPerSec),
        });
      }
    }, 500);

    try {
      await pipeline(readable, ws);
    } finally {
      clearInterval(progressInterval);
    }

    // A stream that ends early ends *cleanly* here too, so the length Apple
    // announced is the only thing that can tell a whole file from a short one.
    await this.assertComplete();
    this.onProgress?.({ downloaded, total: this.totalSize, speed: "0 B/s" });
  }

  /**
   * Execute the download.
   * Probes for Range support, then either downloads in parallel chunks
   * or falls back to single-stream.
   */
  async download(signal: AbortSignal): Promise<void> {
    let supportsRange = false;
    let contentLength = 0;
    try {
      const probeResult = await this.probe(signal);
      supportsRange = probeResult.supportsRange;
      contentLength = probeResult.contentLength;
    } catch {
      // HEAD failed — fall back to single-stream
    }

    if (contentLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(
        `File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_SIZE} byte limit`,
      );
    }

    if (!supportsRange || this.threads <= 1) {
      await this.downloadSingleStream(signal);
      return;
    }

    this.totalSize = contentLength;
    const chunks = this.splitChunks(contentLength);
    // Seed from whatever a previous paused attempt left on disk, so progress
    // resumes from the real byte count and completed chunks are skipped.
    this.chunkBytes = readPartSizes(this.destPath, chunks.length);
    const resumedBytes = this.chunkBytes.reduce((a, b) => a + b, 0);
    if (resumedBytes > 0) {
      this.onProgress?.({
        downloaded: resumedBytes,
        total: this.totalSize,
        speed: "0 B/s",
      });
    }

    this.lastProgressTime = Date.now();
    this.lastProgressBytes = resumedBytes;
    const progressInterval = setInterval(() => {
      const now = Date.now();
      const totalDownloaded = this.chunkBytes.reduce((a, b) => a + b, 0);
      const elapsed = now - this.lastProgressTime;

      let speed = "0 B/s";
      if (elapsed > 0) {
        const bytesPerSec =
          ((totalDownloaded - this.lastProgressBytes) / elapsed) * 1000;
        speed = formatSpeed(bytesPerSec);
      }
      this.lastProgressTime = now;
      this.lastProgressBytes = totalDownloaded;

      this.onProgress?.({
        downloaded: totalDownloaded,
        total: this.totalSize,
        speed,
      });
    }, 500);

    try {
      await Promise.all(
        chunks.map((chunk) => this.downloadChunk(chunk, signal)),
      );

      clearInterval(progressInterval);
      await this.mergeChunks(chunks.length);

      this.onProgress?.({
        downloaded: this.totalSize,
        total: this.totalSize,
        speed: "0 B/s",
      });
    } catch (err) {
      clearInterval(progressInterval);
      // An abort() already made its keep-or-clean decision (pause keeps the
      // parts for resume; delete/timeout cleaned them), so only a genuine
      // failure cleans up here.
      if (!this.aborted) {
        this.cleanPartFiles(chunks.length);
      }
      throw err;
    }
  }

  /**
   * Abort all active connections. `keepParts` leaves completed `.part` files
   * on disk so a subsequent download of the same destination can skip the
   * chunks it already holds — this is what pause/resume rides on.
   */
  abort(keepParts = false): void {
    this.aborted = true;
    for (const ac of this.abortControllers) {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
    this.abortControllers.clear();

    if (!keepParts) {
      removePartFiles(this.destPath);
    }
  }
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024)
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
