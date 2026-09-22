import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  decryptMacOSPackage,
  describeDecrypterFailure,
  parseProgressReport,
  HELPER_CANDIDATES,
} from "../src/services/macDecrypt.js";

const tempFiles: string[] = [];

function writeTemp(name: string, bytes: Buffer): string {
  const filePath = path.join(os.tmpdir(), `asspp-${name}-${Date.now()}`);
  fs.writeFileSync(filePath, bytes);
  tempFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  while (tempFiles.length > 0) {
    const filePath = tempFiles.pop();
    if (!filePath) continue;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already gone — nothing to clean up.
    }
  }
});

/**
 * The helper is a separate binary that only exists in the built image, so what
 * is covered here is everything around it: the reports it sends back, the way
 * its failures are worded, and what happens when there is nothing to run. The
 * spawn itself is exercised against a real package and a real helper outside
 * the suite (see the note in `services/macDecrypt.ts`).
 */
describe("parseProgressReport", () => {
  it("reads one report", () => {
    expect(parseProgressReport("progress 4194304 70621992")).toEqual({
      written: 4194304,
      total: 70621992,
    });
  });

  it("ignores every other line the helper prints", () => {
    // The summary line comes after the last report and is not one.
    expect(
      parseProgressReport("decrypted 70621992 bytes to /tmp/app.pkg"),
    ).toBeUndefined();
    expect(parseProgressReport("")).toBeUndefined();
    expect(parseProgressReport("progress 4194304")).toBeUndefined();
    expect(parseProgressReport("progress  4194304 70621992")).toBeUndefined();
    expect(parseProgressReport("macdecrypt: boom")).toBeUndefined();
  });
});

describe("describeDecrypterFailure", () => {
  it("continues the sentence with the helper's own reason", () => {
    // The helper names the bytes it found, which is what identifies what Apple
    // actually served: the same four bytes the instance once stored.
    const stderr =
      "macdecrypt: decrypted package is not a xar archive (starts with 0x ba 6b 39 e3)\n";

    expect(describeDecrypterFailure(stderr, 1)).toBe(
      "the macOS package could not be decrypted: decrypted package is not a xar archive (starts with 0x ba 6b 39 e3)",
    );
  });

  it("keeps the last thing the helper said", () => {
    expect(describeDecrypterFailure("warming up\nmacdecrypt: no dpInfo\n", 1)).toBe(
      "the macOS package could not be decrypted: no dpInfo",
    );
  });

  it("falls back to the exit code when the helper said nothing", () => {
    expect(describeDecrypterFailure("  \n", 137)).toMatch(
      /exited with code 137/,
    );
    expect(describeDecrypterFailure("", null)).toMatch(/could not be decrypted/);
  });
});

describe("decryptMacOSPackage", () => {
  it("says the server has no decrypter rather than blaming the package", async () => {
    const filePath = writeTemp(
      "ciphertext",
      Buffer.from([0xba, 0x6b, 0x39, 0xe3]),
    );

    await expect(
      decryptMacOSPackage({
        filePath,
        dpInfo: "AA==",
        hardwareId: "345a6045423b",
        helperPath: path.join(os.tmpdir(), "asspp-no-such-decrypter"),
      }),
    ).rejects.toThrow(/no macOS package decrypter/);
  });

  it("looks for the helper at the image path, then this checkout's", () => {
    // The one configuration-free contract between the build scripts and this
    // service: the second candidate has to name tools/macdecrypt next to the
    // repository root, wherever this file itself lives (src or dist).
    const fromHere = path.resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      `../../tools/macdecrypt/macdecrypt${process.platform === "win32" ? ".exe" : ""}`,
    );
    expect(HELPER_CANDIDATES[0]).toBe("/opt/asspp/macdecrypt");
    expect(path.resolve(HELPER_CANDIDATES[1]).toLowerCase()).toBe(
      fromHere.toLowerCase(),
    );
  });

  it("leaves a file that is already a package alone", async () => {
    // StoreAgent is not a format checker: handed plaintext it decrypts the
    // plaintext into garbage. The guard runs before the helper is even looked
    // for, which is why a path that does not exist is enough here.
    const bytes = Buffer.from("xar!\x00\x1c\x00\x01", "latin1");
    const filePath = writeTemp("decrypted", bytes);

    await decryptMacOSPackage({
      filePath,
      dpInfo: "AA==",
      hardwareId: "345a6045423b",
      helperPath: path.join(os.tmpdir(), "asspp-no-such-decrypter"),
    });

    expect(fs.readFileSync(filePath)).toEqual(bytes);
  });

  it("stops a helper that never finishes instead of waiting forever", async () => {
    // The helper has its own internal timeout, so this side's deadline only
    // ever fires on a helper that hangs past it. The stand-in prints one
    // progress report and then runs forever, which is exactly that case; the
    // short injected deadline is what the production default (35 minutes)
    // would be, shrunk to a test-sized moment.
    const filePath = writeTemp(
      "ciphertext",
      Buffer.from([0xba, 0x6b, 0x39, 0xe3]),
    );
    const standIn =
      "process.stdout.write('progress 0 100\\n'); setInterval(() => {}, 1000);";

    await expect(
      decryptMacOSPackage({
        filePath,
        dpInfo: "AA==",
        hardwareId: "345a6045423b",
        helperPath: process.execPath,
        // The `--` ends node's own option parsing, so the decrypt arguments
        // behind it reach the stand-in as inert argv instead of options.
        helperArgs: ["-e", standIn, "--"],
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/did not finish within/);

    // The rejection must not leave the ciphertext replaced by anything.
    expect(fs.readFileSync(filePath)).toEqual(
      Buffer.from([0xba, 0x6b, 0x39, 0xe3]),
    );
  }, 10_000);
});
