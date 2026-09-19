// Reads a version's real metadata out of its IPA, mirroring ipatool's
// `readVersionMetadataFromIPA` (pkg/appstore/appstore_get_version_metadata.go).
//
// Apple's download-product exchange does carry a `releaseDate`, but that value
// dates the *app*: every pinned version of one app comes back with the same day,
// and the `iTunesMetadata.plist` Apple embeds in the download says the same
// thing — see the releaseDate of a real, compiled package. ipatool therefore
// reads the IPA itself: the app's `Info.plist` `releaseDate`/`ReleaseDate`, and
// the archive entry's modification time when the plist carries none. That is a
// per-build value, which is what the version pickers want.
//
// The package is never downloaded whole: the archive's central directory is
// fetched from the tail and only the Info.plist entry is fetched, both bounded,
// the same way ipatool ranges against the CDN.

import { inflateRawSync } from "node:zlib";
import bplistParser from "bplist-parser";
import plist from "plist";
import { validateDownloadURL } from "./downloadManager.js";

/** Reads `bytes=[start, end]` (inclusive) of a resource. */
export type RangeReader = (start: number, end: number) => Promise<Buffer>;

/** The biggest tail fetched to find the central directory. */
const MAX_TAIL = 16 * 1024 * 1024;
/** The biggest central directory walked. */
const MAX_DIRECTORY = 32 * 1024 * 1024;
/** The biggest file entry fetched (an Info.plist is a few KB, never near this). */
const MAX_ENTRY = 4 * 1024 * 1024;
/** The biggest an entry may inflate to — a zip bomb must not balloon a small one. */
const MAX_ENTRY_OUTPUT = 4 * 1024 * 1024;
/** The first read: enough for the end-of-central-directory record. */
const TAIL_WINDOW = 64 * 1024;
/** One range/HEAD request, bounded so a stalled CDN cannot hang the task. */
const REQUEST_TIMEOUT_MS = 15_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** Zip64 end-of-central-directory locator, which precedes the EOCD when present. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
/** Marker meaning "the real value lives in the zip64 records". */
const ZIP64_MARKER = 0xffffffff;
/** Info.plist of the app in the payload: exactly two levels deep. */
const INFO_PLIST = /^Payload\/[^/]+\.app\/Info\.plist$/;

export interface PackageVersionMetadata {
  displayVersion: string;
  releaseDate: string;
}

/**
 * Reads the version's display version and release date out of an IPA, given a
 * reader over that archive and its total size. Throws when the archive cannot be
 * read or the payload carries no app — the caller treats that as "no date".
 */
export async function readVersionMetadataFromRanges(
  read: RangeReader,
  size: number,
): Promise<PackageVersionMetadata> {
  // Only the end-of-central-directory record itself is a hard minimum (22
  // bytes); anything smaller cannot be an archive at all.
  if (!Number.isFinite(size) || size <= 22) {
    throw new Error("not a zip archive");
  }

  const directory = await readCentralDirectory(read, size);
  const entry = directory.find((candidate) => INFO_PLIST.test(candidate.name));
  if (!entry) throw new Error("no app Info.plist in the payload");

  const data = await readEntry(read, entry);
  const infoPlist = parsePlist(data);

  const displayVersion =
    firstString(infoPlist?.CFBundleShortVersionString) ??
    firstString(infoPlist?.["CFBundleShortVersionString"]);
  if (!displayVersion) throw new Error("no version in Info.plist");

  // ipatool's order: the plist's own date first, then the entry's modification
  // time — never the value the download API handed out.
  const releaseDate =
    plistDate(infoPlist?.releaseDate) ??
    plistDate(infoPlist?.ReleaseDate) ??
    entry.modifiedAt.toISOString();

  return { displayVersion, releaseDate };
}

/**
 * Reads that metadata for a version from its download URL, which is validated
 * like every other package address before a byte of it is fetched.
 */
export async function versionMetadataFromDownloadURL(
  downloadURL: string,
): Promise<PackageVersionMetadata> {
  validateDownloadURL(downloadURL);

  const size = await readContentLength(downloadURL);
  const read: RangeReader = async (start, end) => {
    const response = await fetch(downloadURL, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`range request failed (HTTP ${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  };

  return readVersionMetadataFromRanges(read, size);
}

type DirectoryEntry = {
  name: string;
  localOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  modifiedAt: Date;
};

/**
 * Fetches and walks the archive's central directory. The end-of-central-
 * directory record sits in the last bytes, so a small window finds it and the
 * directory itself is fetched in one more request.
 */
async function readCentralDirectory(
  read: RangeReader,
  size: number,
): Promise<DirectoryEntry[]> {
  const window = Math.min(size, TAIL_WINDOW);
  let tail = await read(size - window, size - 1);
  let base = size - window;
  let eocd = lastIndexOfSignature(tail, EOCD_SIGNATURE);

  // A comment can push the record out of the first window; widen once, bounded.
  if (eocd === -1 && size > MAX_TAIL) {
    base = size - MAX_TAIL;
    tail = await read(base, size - 1);
    eocd = lastIndexOfSignature(tail, EOCD_SIGNATURE);
  }
  if (eocd === -1) throw new Error("not a zip archive");

  // Zip64 relocates the real values into extra records this reader does not
  // walk. Detect it two ways — the locator record that precedes the EOCD, and
  // the 0xFFFFFFFF marker fields — and say so, instead of failing later with a
  // nonsense offset. No App Store IPA is zip64 (entries are far below 4 GiB),
  // so refusing is the honest outcome.
  const entries = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (
    (eocd >= 20 &&
      tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) ||
    directoryOffset === ZIP64_MARKER ||
    directorySize === ZIP64_MARKER
  ) {
    throw new Error("zip64 archives are not supported");
  }
  if (directorySize === 0 || directorySize > MAX_DIRECTORY) {
    throw new Error("unreadable central directory");
  }

  const directory =
    directoryOffset >= base
      ? tail.subarray(directoryOffset - base, directoryOffset - base + directorySize)
      : await read(directoryOffset, directoryOffset + directorySize - 1);

  const parsed: DirectoryEntry[] = [];
  let offset = 0;
  for (let index = 0; index < entries; index += 1) {
    // A truncated directory (the EOCD's entry count is corrupt) would otherwise
    // surface as a raw RangeError from readUInt32LE below; fail with a readable
    // error instead. 46 is the fixed central-directory header length.
    if (offset + 46 > directory.length) {
      throw new Error("unreadable central directory");
    }
    if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = directory.readUInt16LE(offset + 10);
    // The directory stores the modification time first, the date after it.
    const modifiedAt = dosDateTime(
      directory.readUInt16LE(offset + 14),
      directory.readUInt16LE(offset + 12),
    );
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new Error("zip64 archives are not supported");
    }
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localOffset = directory.readUInt32LE(offset + 42);
    const name = directory
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    parsed.push({
      name,
      localOffset,
      compressedSize,
      uncompressedSize,
      method,
      modifiedAt,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return parsed;
}

/** Fetches one entry's bytes: its local header names the data to follow. */
async function readEntry(
  read: RangeReader,
  entry: DirectoryEntry,
): Promise<Buffer> {
  if (entry.compressedSize > MAX_ENTRY) throw new Error("entry too large");
  if (entry.uncompressedSize > MAX_ENTRY_OUTPUT) throw new Error("entry too large");
  const header = await read(entry.localOffset, entry.localOffset + 29);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = await read(start, start + entry.compressedSize - 1);

  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    // A declared size that lies can still inflate far past the limit, so the
    // decompressor gets the same bound as a second line of defense.
    return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_OUTPUT });
  }
  throw new Error(`unsupported compression method ${entry.method}`);
}

async function readContentLength(url: string): Promise<number> {
  const response = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    const value = Number(response.headers.get("content-length"));
    if (Number.isFinite(value) && value > 0) return value;
  }
  // Some CDNs answer HEAD with nothing useful: a one-byte range returns the
  // total in `Content-Range`.
  const ranged = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const range = ranged.headers.get("content-range");
  const total = range?.match(/\/(\d+)$/)?.[1];
  if (!total) throw new Error("unknown archive size");
  return Number(total);
}

function parsePlist(data: Buffer): Record<string, unknown> | null {
  try {
    const parsed = bplistParser.parseBuffer(data);
    if (parsed?.[0]) return parsed[0] as Record<string, unknown>;
  } catch {
    // Not a binary plist; try XML.
  }
  try {
    const xml = data.toString("utf8");
    if (xml.includes("<?xml") || xml.includes("<plist")) {
      const parsed = plist.parse(xml);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Not a plist at all.
  }
  return null;
}

function plistDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * MS-DOS date and time, as the zip directory stores it. Built in UTC so the
 * result matches what yauzl's `getLastMod()` reports for the same entry — the
 * value the download pipeline already records for compiled packages.
 */
function dosDateTime(date: number, time: number): Date {
  return new Date(
    Date.UTC(
      ((date >> 9) & 0x7f) + 1980,
      ((date >> 5) & 0x0f) - 1,
      date & 0x1f,
      (time >> 11) & 0x1f,
      (time >> 5) & 0x3f,
      (time & 0x1f) * 2,
    ),
  );
}

function lastIndexOfSignature(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}
