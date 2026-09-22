import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  assertMacOSPackage,
  PackagePlatformError,
} from "../src/services/packagePlatform.js";

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
      // The file is a temp artifact; nothing to clean up when it is gone.
    }
  }
});

describe("assertMacOSPackage", () => {
  it("accepts a macOS package (xar)", async () => {
    const filePath = writeTemp("pkg", Buffer.from("xar!\x00\x1c\x00\x01", "latin1"));

    await expect(assertMacOSPackage(filePath)).resolves.toBeUndefined();
  });

  it("refuses an IPA a macOS task was served", async () => {
    // The build the MDM catalogue reports for platform=osx is an iOS one, so a
    // macOS task really can be handed a zip archive instead of a xar container.
    const filePath = writeTemp("ipa", Buffer.from("PK\x03\x04rest", "latin1"));

    await expect(assertMacOSPackage(filePath)).rejects.toThrow(
      PackagePlatformError,
    );
    await expect(assertMacOSPackage(filePath)).rejects.toThrow(
      /served an IPA instead of a Mac package/,
    );
  });

  it("refuses a file too short to declare an archive format", async () => {
    const filePath = writeTemp("short", Buffer.from("xa", "latin1"));

    await expect(assertMacOSPackage(filePath)).rejects.toThrow(
      /could not be read/,
    );
  });

  it("refuses a file that is not there", async () => {
    const filePath = path.join(os.tmpdir(), "asspp-missing-package");

    await expect(assertMacOSPackage(filePath)).rejects.toThrow(
      /could not be read/,
    );
  });
});
