// Package platform validation, mirroring ipatool's `validatePackagePlatform`
// (pkg/appstore/appstore_download.go). After the backend downloads an IPA, the
// package's own Info.plist must declare support for a known platform in its
// `CFBundleSupportedPlatforms` — otherwise Apple served something we cannot
// identify, and installing it would silently give the user the wrong thing.
//
// The package's own declaration is the authority, not the platform the request
// carried: a manual download can pin a tvOS version id while the platform
// selector still reads iOS, and the package that comes back is a tvOS build.
// Validating against the request's platform would reject a perfectly good IPA.
//
// macOS packages (.pkg) are xar containers, not IPAs, and are skipped: the Mac
// flow selects the native offer before the download, so a mismatched package
// never reaches this point.

import { open as openZip } from "yauzl-promise";
import type { Readable } from "stream";
import bplistParser from "bplist-parser";
import plist from "plist";
import type { Platform } from "../types/index.js";

/**
 * Thrown when the downloaded IPA does not declare support for any known
 * platform. Callers check `instanceof PackagePlatformError` to surface the
 * message to the user instead of the generic "Download failed".
 */
export class PackagePlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagePlatformError";
  }
}

/**
 * Infers the platform a package targets from its `CFBundleSupportedPlatforms`.
 * A universal app lists several; the first non-iPhoneOS entry distinguishes
 * tvOS (`AppleTVOS`) and visionOS (`XROS`). When only `iPhoneOS` is present the
 * package is an iOS/iPad build. macOS packages are `.pkg` (xar), not IPAs, so
 * they never reach this function.
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
 * Validates that the downloaded IPA declares support for at least one known
 * platform in its `CFBundleSupportedPlatforms`, and returns that platform so the
 * caller can correct the task when the request's platform was wrong (e.g. a
 * manual download that pinned a tvOS version id with the selector on iOS).
 * Throws {@link PackagePlatformError} when no known platform is declared.
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