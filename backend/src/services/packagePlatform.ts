// Package platform validation, mirroring ipatool's `validatePackagePlatform`
// (pkg/appstore/appstore_download.go). The package's own Info.plist `CFBundleSupportedPlatforms`
// is the authority, not the platform the request carried: a by-ID download can pin a tvOS version
// id while the selector still reads iOS, so validating the request would reject a good IPA. macOS
// (.pkg, a xar not an IPA) is skipped here and checked by `assertMacOSPackage` instead.

import fs from "fs";
import { open as openZip } from "yauzl-promise";
import type { Readable } from "stream";
import bplistParser from "bplist-parser";
import plist from "plist";
import type { Platform } from "../types/index.js";

/**
 * Thrown when the downloaded IPA does not declare support for any known platform. Callers
 * check `instanceof PackagePlatformError` to surface the message instead of the generic
 * "Download failed".
 */
export class PackagePlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagePlatformError";
  }
}

/**
 * Infers the platform a package targets from its `CFBundleSupportedPlatforms`. A universal
 * app lists several; the first non-iPhoneOS entry distinguishes tvOS (`AppleTVOS`) and
 * visionOS (`XROS`); only `iPhoneOS` means an iOS/iPad build. `.pkg` (xar) never reaches this.
 */
export function platformFromSupported(
  infoPlist: Record<string, unknown> | null,
): Platform | undefined {
  if (!infoPlist) return undefined;
  const supported = infoPlist.CFBundleSupportedPlatforms;
  if (!Array.isArray(supported)) return undefined;

  if (supported.includes("XROS")) return "visionos";
  if (supported.includes("AppleTVOS")) return "tvos";
  if (supported.includes("iPhoneOS")) return "ios";
  return undefined;
}

/**
 * Validates that the downloaded IPA declares support for at least one known platform in its
 * `CFBundleSupportedPlatforms`, returning that platform so the caller can correct the task
 * when the request's was wrong (e.g. a tvOS version id pinned with the selector on iOS).
 * Throws {@link PackagePlatformError} when none is declared.
 */
export async function validatePackagePlatform(
  ipaPath: string,
): Promise<Platform | undefined> {
  const zip = await openZip(ipaPath);
  try {
    for await (const entry of zip) {
      if (!isTopLevelAppInfoPlist(entry.filename)) continue;

      const stream = await entry.openReadStream();
      const data = await streamToBuffer(stream);
      const info = parsePlistBuffer(data);
      if (!info) continue;

      const platform = platformFromSupported(info);
      if (platform) return platform;
    }
  } finally {
    await zip.close();
  }

  throw new PackagePlatformError(
    "downloaded package does not declare any known platform support",
  );
}

/**
 * What Apple hands a macOS task when the version pin it sent named another platform's build.
 * Named once because both the archive check and the decrypter's pre-flight report it.
 */
export const IPA_SERVED_TO_MACOS =
  "a macOS download was served an IPA instead of a Mac package (.pkg)";

/**
 * Refuses a macOS download whose package is not a `.pkg`. Asking macOS does not guarantee a Mac
 * build: the pin can name an iOS build (Apple's MDM answers an iOS offer even when asked
 * `platform=osx`) and then serve an IPA nothing later would catch — no sinfs, so it looks finished
 * until installed. xar vs zip magic is the only self-signal the package gives: a zip gets
 * {@link IPA_SERVED_TO_MACOS}, anything else reports its leading bytes. Skipped-decryption
 * ciphertext lands here too; its own step reports why.
 */
export async function assertMacOSPackage(pkgPath: string): Promise<void> {
  const magic = await readArchiveMagic(pkgPath);

  if (magic === null) {
    throw new PackagePlatformError("macOS package could not be read");
  }

  if (magic === "xar!") return;

  if (magic.startsWith("PK")) {
    throw new PackagePlatformError(IPA_SERVED_TO_MACOS);
  }

  const firstBytes = Buffer.from(magic, "latin1").toString("hex");
  throw new PackagePlatformError(
    `the macOS download is not a Mac package (.pkg): it starts with 0x${firstBytes}`,
  );
}

/** The first four bytes of a file, or null when it cannot be read. */
export async function readArchiveMagic(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | undefined;

  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead < 4 ? null : buffer.toString("latin1");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function isTopLevelAppInfoPlist(filePath: string): boolean {
  const parts = filePath.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "Payload" &&
    parts[1].endsWith(".app") &&
    parts[2] === "Info.plist"
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parsePlistBuffer(data: Buffer): Record<string, unknown> | null {
  try {
    const parsed = bplistParser.parseBuffer(data);
    if (parsed && parsed.length > 0) {
      return parsed[0] as Record<string, unknown>;
    }
  } catch {
    // Not binary plist, try XML
  }

  try {
    const xml = data.toString("utf-8");
    if (xml.includes("<?xml") || xml.includes("<plist")) {
      const parsed = plist.parse(xml);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Not valid XML plist either
  }

  return null;
}