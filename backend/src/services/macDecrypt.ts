// Decryption of macOS App Store packages, mirroring ipatool's
// `appstore_download_macos.go` (pkg/appstore).
//
// Apple does not serve a Mac download as a `.pkg`: the bytes are FairPlay
// ciphertext, and they only become a xar container once Apple's own StoreAgent
// has decrypted them. StoreAgent runs inside the CommerceKit stack, so driving
// it means emulating that (which is what the `macdecrypt` helper does, built
// from ipatool — see `tools/macdecrypt` and the Dockerfile stage). What it needs
// from us is the `dpInfo` Apple answered the download with and the hardware id
// the download was requested with; both travel on the task.
//
// The helper is a separate process on purpose: the emulation needs an x86_64
// interpreter, and the alternative — doing it in the browser, where the SAP
// machinery already lives — is not viable at these sizes, because our engine is
// an interpreter rather than a JIT and a package takes minutes to decrypt.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
// The one reader of archive magic: a package this already recognises must not
// be handed to StoreAgent, and the pipeline asks the same question before it
// calls this.
import { readArchiveMagic } from "./packagePlatform.js";

/**
 * This side's own deadline for the helper. The helper times its work out
 * internally (30 minutes, covering the asset download, the emulation and the
 * decryption), so this only exists for the case that deadline cannot reach: a
 * helper that hangs outside its own context — or ignores the signal — would
 * otherwise hold the task in `injecting` forever.
 */
export const MACDECRYPT_TIMEOUT_MS = 35 * 60 * 1000;

/** How long a stopped helper has to react to its termination signal. */
const KILL_ESCALATION_MS = 5_000;

/**
 * Where the decrypter is looked for, first hit wins — there is no
 * configuration. The image bakes it into `/opt/asspp/macdecrypt`; a
 * development instance builds it with `tools/macdecrypt/build.sh` (or
 * `build.ps1`) into this repository's own `tools/macdecrypt/`, from a checkout
 * that is three levels above this file in either layout (`src/services` or
 * `dist/services`).
 */
export const HELPER_CANDIDATES = [
  "/opt/asspp/macdecrypt",
  fileURLToPath(
    new URL(
      `../../../tools/macdecrypt/macdecrypt${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  ),
];

export interface MacDecryptOptions {
  /** Encrypted package on disk; replaced in place by the decrypted one. */
  filePath: string;
  /** Base64 `dpInfo` from the download response's sinfs. */
  dpInfo: string;
  /** The download request's hardware id (`guid`), hex encoded. */
  hardwareId: string;
  /** Aborting kills the helper; nothing half-decrypted is left behind. */
  signal?: AbortSignal;
  /** 0…1, from the helper's own byte reports. */
  onProgress?: (ratio: number) => void;
  /** Overrides where the helper is — a test's stand-in. */
  helperPath?: string;
  /** Arguments handed to the helper ahead of its own — how tests inject a stand-in. */
  helperArgs?: string[];
  /**
   * This side's deadline for the helper, in milliseconds. Defaults to
   * {@link MACDECRYPT_TIMEOUT_MS}; tests pass something small.
   */
  timeoutMs?: number;
}

/**
 * Decrypts `options.filePath` with Apple's StoreAgent, replacing the file with
 * the package it decrypts to.
 *
 * The file is expected to hold ciphertext, and a file that already reads as a
 * package is returned untouched: StoreAgent is not a format checker, so running
 * it over plaintext decrypts the plaintext into garbage (observed, the once
 * this guard was missing). The caller reports the cases this cannot, because it
 * knows what it asked Apple for.
 */
export async function decryptMacOSPackage(
  options: MacDecryptOptions,
): Promise<void> {
  if ((await readArchiveMagic(options.filePath)) === "xar!") return;

  const helper =
    options.helperPath ?? HELPER_CANDIDATES.find((c) => fs.existsSync(c));
  if (!helper || !fs.existsSync(helper)) {
    throw new Error(
      helper
        ? `this server has no macOS package decrypter (${helper})`
        : `this server has no macOS package decrypter (expected it at ${HELPER_CANDIDATES.join(" or ")})`,
    );
  }

  const decryptedPath = `${options.filePath}.decrypted`;
  // The dpInfo is the key material this package is decrypted with, so it is
  // handed over in a file rather than on the command line, where any other
  // process could read it out of the process list.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-macdecrypt-"));
  const dpInfoPath = path.join(scratch, "dpinfo");

  try {
    fs.writeFileSync(dpInfoPath, options.dpInfo, { mode: 0o600 });

    await runDecrypter(
      helper,
      [
        "-in",
        options.filePath,
        "-out",
        decryptedPath,
        "-hardware-id",
        options.hardwareId,
        "-dp-info",
        `@${dpInfoPath}`,
      ],
      {
        signal: options.signal,
        onProgress: options.onProgress,
        totalBytes: fs.statSync(options.filePath).size,
        helperArgs: options.helperArgs,
        timeoutMs: options.timeoutMs,
      },
    );

    // Only a complete decryption is allowed to replace the ciphertext: the
    // temporary file is on the same filesystem, so this is a rename.
    fs.renameSync(decryptedPath, options.filePath);
  } finally {
    // The timeout settles before the helper has exited, so a helper still
    // holding the half-written output can make this removal fail — on Windows,
    // where an open file cannot be unlinked. A leftover `.decrypted` file is
    // the lesser harm; a throwing cleanup here would replace the reason the
    // user can act on with an unlink error.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
      if (fs.existsSync(decryptedPath)) {
        fs.rmSync(decryptedPath, { force: true });
      }
    } catch {
      // A leftover `.decrypted` beside the task's package; it only costs disk,
      // and the platform this bites on is the one without POSIX unlink-while-open.
    }
  }
}

interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
  /** Used when a progress line does not carry a total of its own. */
  totalBytes: number;
  /** Arguments handed to the helper ahead of its own — a test hook. */
  helperArgs?: string[];
  /** This side's deadline for the helper; tests pass something small. */
  timeoutMs?: number;
}

/**
 * Stops the helper. One signal is a request the helper is expected to honour;
 * the escalation exists because the whole point of stopping it is that it has
 * already stopped responding — a helper that ignores the first signal must not
 * outlive the caller that gave up on it.
 */
function killHelper(child: ChildProcess): void {
  child.kill();

  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, KILL_ESCALATION_MS);
  // The helper is usually already gone by now; the timer must not hold the
  // process open just to discover that.
  escalate.unref();
}

function runDecrypter(
  helper: string,
  args: string[],
  options: RunOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [...(options.helperArgs ?? []), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // The helper fetches Apple's assets and the Unicorn runtime it emulates
        // with, and caches both under the user cache directory. On Linux — the
        // container — that is XDG_CACHE_HOME, so anchoring it inside DATA_DIR
        // keeps them across a container being replaced; otherwise every fresh
        // container pays for the download on its first macOS package.
        XDG_CACHE_HOME: path.join(config.dataDir, "cache"),
      },
    });

    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };

    // This side's deadline. The helper has its own, but a helper that hangs
    // outside it (or ignores its signal) would otherwise hold the task in
    // `injecting` forever. Settling here rather than waiting for `close` keeps
    // the promise from outliving a helper that never exits at all.
    const limit = options.timeoutMs ?? MACDECRYPT_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      killHelper(child);
      fail(
        new Error(
          `the macOS package decrypter did not finish within ${Math.round(limit / 60_000)} minutes and was stopped`,
        ),
      );
    }, limit);

    // Aborting is how a delete stops the work: the helper holds the open
    // output file, so it has to go before the scratch file can. Same
    // escalation as the deadline — an aborted helper must be gone, not asked.
    const onAbort = () => killHelper(child);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) killHelper(child);

    let carry = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      carry += chunk;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";

      for (const line of lines) {
        const progress = parseProgressReport(line);
        if (!progress) continue;
        const total = progress.total || options.totalBytes;
        if (total > 0) {
          options.onProgress?.(Math.min(1, progress.written / total));
        }
      }
    });

    // The helper's own message is what the user can act on, and it is small.
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });

    child.on("error", (error) => {
      fail(
        new Error(
          `the macOS package decrypter could not be started: ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);

      if (options.signal?.aborted) {
        // Named like the downloader's own aborts, so a timeout reads the same
        // however far into the attempt it lands.
        const aborted = new Error("Aborted");
        aborted.name = "AbortError";
        fail(aborted);
        return;
      }

      if (code === 0) {
        succeed();
        return;
      }

      fail(new Error(describeDecrypterFailure(stderr, code)));
    });
  });
}

/**
 * Reads one `progress <written> <total>` report. Anything else the helper
 * prints (its summary line, say) is not progress and is ignored.
 */
export function parseProgressReport(
  line: string,
): { written: number; total: number } | undefined {
  const match = /^progress (\d+) (\d+)$/.exec(line.trim());
  if (!match) return undefined;

  const written = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(written) || !Number.isFinite(total)) return undefined;

  return { written, total };
}

/**
 * Turns the helper's stderr into a message for the task. The helper prefixes
 * its own errors with the command name; dropping that lets the sentence read as
 * a continuation of ours ("the macOS package could not be decrypted: …").
 */
export function describeDecrypterFailure(
  stderr: string,
  code: number | null,
): string {
  const last = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  if (!last) {
    return `the macOS package could not be decrypted (the decrypter exited with code ${code})`;
  }

  const detail = last.startsWith("macdecrypt: ")
    ? last.slice("macdecrypt: ".length)
    : last;

  return `the macOS package could not be decrypted: ${detail}`;
}
