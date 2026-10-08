import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { ZipArchive } from "archiver";
import { open as openZip, type Entry } from "yauzl-promise";
import type { Readable } from "stream";
import bplistParser from "bplist-parser";
import bplistCreator from "bplist-creator";
import plist from "plist";
import { convertCgbiToPng, isCgbiPng } from "./cgbiPng.js";
import { platformFromSupported } from "./packagePlatform.js";
import type { Sinf, Platform } from "../types/index.js";

const execFile = promisify(execFileCb);

interface IpaMetadata {
  bundleName: string;
  manifest: { sinfPaths: string[] } | null;
  info: { bundleExecutable: string } | null;
  /** The app's parsed Info.plist, as declared by the package itself. */
  infoPlist: Record<string, unknown> | null;
  /** The ZIP entry modification time of Info.plist — a fallback release date. */
  infoPlistDate: Date | null;
  /** The parsed `iTunesMetadata.plist` written by a previous injection. */
  storeMetadata: Record<string, unknown> | null;
  /** Images sitting at the top of the app bundle, any of which may be the icon. */
  iconCandidates: IconCandidate[];
}

/**
 * `Payload/<App>.app/<name>` — a file at the top of the app bundle. Exactly two
 * slashes keeps nested bundles' icons (extensions, watch apps) out.
 */
const APP_ROOT_IMAGE_RE = /^Payload\/[^/]+\.app\/([^/]+\.(?:png|jpe?g))$/i;

/** Apple names the loose icon files it ships; nothing else at the root does. */
const ICON_HINT_RE = /^(?:app)?icon(?:[-_@.~]|\d|$)/i;

/** A multi-MB PNG at the bundle root is artwork, not the app icon. */
const MAX_ICON_BYTES = 4 * 1024 * 1024;
/** Upper bound on an in-package plist read back whole (iTunesMetadata / manifests / Info.plist). */
const MAX_PLIST_ENTRY = 16 * 1024 * 1024;

/** An image the package carries, as listed in the archive's central directory. */
interface IconCandidate {
  entryName: string;
  /** File name inside the app bundle — the last path segment. */
  name: string;
  /** Declared uncompressed size, used to rank variants of the same icon. */
  size: number;
}

/** The app icon lifted out of a package. */
export interface PackageIcon {
  /** File name the icon had inside the app bundle. */
  filename: string;
  data: Buffer;
}

/** Metadata a compiled package declares about the app it contains. */
export interface PackageMetadata {
  name?: string;
  artistName?: string;
  bundleID?: string;
  version?: string;
  minimumOsVersion?: string;
  primaryGenreName?: string;
  releaseDate?: string;
  /**
   * Where Apple serves the app's icon, written into the package by injection.
   * The only option for packages with no loose image (a tvOS build keeps its
   * icon inside `Assets.car`).
   */
  artworkURL?: string;
  /** Apple's external version identifier, read from the store metadata. */
  externalVersionId?: string;
  /**
   * The platform the package targets, from `CFBundleSupportedPlatforms`. The
   * authority over the requested platform: an app searched as tvOS may have
   * served its iOS build.
   */
  platform?: Platform;
}

export interface InjectResult {
  /**
   * Metadata read out of the package (Info.plist plus the injected
   * iTunesMetadata.plist) — the source of truth for what it contains.
   */
  metadata: PackageMetadata;
  /**
   * The app's icon, when the bundle carries one — the only way a bare-app-id
   * download can show one.
   */
  icon?: PackageIcon;
}

export async function inject(
  sinfs: Sinf[],
  ipaPath: string,
  iTunesMetadata?: string,
): Promise<InjectResult> {
  const { bundleName, manifest, info, infoPlist, infoPlistDate, iconCandidates } =
    await readIpaMetadata(ipaPath);

  // Read the icon before the archive is rewritten, so a missing one still
  // compiles.
  const icon = await readPackageIcon(
    ipaPath,
    bundleName,
    infoPlist,
    iconCandidates,
  );

  // Collect all files to inject
  const filesToInject: { entryPath: string; data: Buffer }[] = [];

  if (manifest) {
    for (let i = 0; i < manifest.sinfPaths.length; i++) {
      if (i >= sinfs.length) continue;
      const sinfPath = manifest.sinfPaths[i];
      const fullPath = `Payload/${bundleName}.app/${sinfPath}`;
      filesToInject.push({
        entryPath: fullPath,
        data: Buffer.from(sinfs[i].sinf, "base64"),
      });
    }
  } else if (info) {
    if (sinfs.length > 0) {
      const sinfPath = `Payload/${bundleName}.app/SC_Info/${info.bundleExecutable}.sinf`;
      filesToInject.push({
        entryPath: sinfPath,
        data: Buffer.from(sinfs[0].sinf, "base64"),
      });
    }
  } else {
    throw new Error("Could not read manifest or info plist");
  }

  // Frontend sends base64 XML; convert to Apple's binary plist format.
  let storeMetadata: Record<string, unknown> | null = null;
  if (iTunesMetadata) {
    const xmlBuffer = Buffer.from(iTunesMetadata, "base64");
    const xmlString = xmlBuffer.toString("utf-8");
    let metadataBuffer: Buffer;
    try {
      const parsed = plist.parse(xmlString) as Record<string, unknown>;
      storeMetadata = parsed;
      metadataBuffer = bplistCreator(parsed);
    } catch {
      metadataBuffer = xmlBuffer;
    }
    filesToInject.push({
      entryPath: "iTunesMetadata.plist",
      data: metadataBuffer,
    });
  }

  if (filesToInject.length > 0) {
    await addFilesToZip(ipaPath, filesToInject);
  }

  return { metadata: packageMetadata(storeMetadata, infoPlist, infoPlistDate), icon };
}

/**
 * Reads what an already compiled package can still tell us without touching it:
 * the store metadata (where the icon URL lives) and, if present, the icon.
 */
export async function readPackageInfo(
  ipaPath: string,
): Promise<{ metadata: PackageMetadata; icon?: PackageIcon }> {
  const { bundleName, infoPlist, infoPlistDate, storeMetadata, iconCandidates } =
    await readIpaMetadata(ipaPath);

  return {
    metadata: packageMetadata(storeMetadata, infoPlist, infoPlistDate),
    icon: await readPackageIcon(ipaPath, bundleName, infoPlist, iconCandidates),
  };
}

/** First non-empty value among the given keys of a parsed plist. */
function firstString(
  source: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!source) return undefined;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") return trimmed;
    }
    // A plist <date> parses to a Date.
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
  }

  return undefined;
}

/**
 * Reads the release date from Info.plist (mirrors ipatool's
 * `readVersionMetadataFromIPA`): Apple's API can return stale values, so the
 * package is the source of truth. ZIP entry mtime is the fallback.
 */
function releaseDateFromPackage(
  infoPlist: Record<string, unknown> | null,
  fallback?: Date | null,
): string | undefined {
  if (infoPlist) {
    for (const key of ["releaseDate", "ReleaseDate"]) {
      const value = infoPlist[key];
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
      }
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
  }
  if (fallback && !Number.isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }
  return undefined;
}

/**
 * Like {@link firstString} but also coerces numbers — Apple's
 * `softwareVersionExternalIdentifier` is an integer in the plist.
 */
function firstValue(
  source: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!source) return undefined;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" && !Number.isNaN(value)) {
      return String(value);
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
  }

  return undefined;
}

/**
 * Collects what the package says about the app. Apple's store metadata wins
 * where both are available; Info.plist covers what it leaves out.
 */
function packageMetadata(
  store: Record<string, unknown> | null,
  infoPlist: Record<string, unknown> | null,
  infoPlistDate?: Date | null,
): PackageMetadata {
  return {
    name:
      firstString(store, ["bundleDisplayName", "itemName"]) ??
      firstString(infoPlist, ["CFBundleDisplayName", "CFBundleName"]),
    artistName: firstString(store, ["artistName", "sellerName"]),
    bundleID:
      firstString(store, ["softwareVersionBundleId"]) ??
      firstString(infoPlist, ["CFBundleIdentifier"]),
    version:
      firstString(store, ["bundleShortVersionString"]) ??
      firstString(infoPlist, ["CFBundleShortVersionString"]),
    minimumOsVersion:
      firstString(infoPlist, ["MinimumOSVersion"]) ??
      firstString(store, ["minimumOsVersion"]),
    primaryGenreName: firstString(store, ["primaryGenreName", "genre"]),
    releaseDate: releaseDateFromPackage(infoPlist, infoPlistDate),
    artworkURL: sharperIconURL(
      firstString(store, ["softwareIcon57x57URL", "artworkURL"]),
    ),
    externalVersionId: firstValue(store, ["softwareVersionExternalIdentifier"]),
    platform: platformFromSupported(infoPlist),
  };
}

/**
 * mzstatic thumbnails encode their size in the path (`…/114x114bb.jpg`);
 * Apple's 57pt one is soft at 80px, and the CDN renders any size, so ask for a
 * larger one. URLs that don't match are left alone.
 */
const THUMBNAIL_SIZE_RE = /\/(\d+)x(\d+)(bb\.(?:png|jpe?g))$/i;
const PREFERRED_ICON_SIZE = 512;

function sharperIconURL(url?: string): string | undefined {
  if (!url) return undefined;

  const match = THUMBNAIL_SIZE_RE.exec(url);
  if (!match || Number(match[1]) >= PREFERRED_ICON_SIZE) return url;

  const size = `${PREFERRED_ICON_SIZE}x${PREFERRED_ICON_SIZE}${match[3]}`;
  return `${url.slice(0, match.index + 1)}${size}`;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    // These entries are a few-KB plists; a package may declare any size, so
    // refuse one that would balloon memory rather than trust the archive's
    // declared lengths.
    if (total > MAX_PLIST_ENTRY) {
      stream.destroy();
      throw new Error("plist entry too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readIpaMetadata(ipaPath: string): Promise<IpaMetadata> {
  const zip = await openZip(ipaPath);
  try {
    let bundleName: string | null = null;
    let manifestData: Buffer | null = null;
    let infoPlistData: Buffer | null = null;
    let infoPlistDate: Date | null = null;
    let storeMetadataData: Buffer | null = null;
    const iconCandidates: IconCandidate[] = [];

    for await (const entry of zip) {
      const filename = entry.filename;

      // Store metadata written by a previous injection; reading it back is how
      // a compiled package reports what Apple said, icon included.
      if (!storeMetadataData && filename === "iTunesMetadata.plist") {
        const stream = await entry.openReadStream();
        storeMetadataData = await streamToBuffer(stream);
      }

      // Gather candidate icons; choosing among them needs the Info.plist.
      const candidate = iconCandidateForEntry(filename, entry);
      if (candidate) iconCandidates.push(candidate);

      // Find bundle name from .app directory
      if (
        !bundleName &&
        filename.includes(".app/Info.plist") &&
        !filename.includes("/Watch/")
      ) {
        const components = filename.split("/");
        for (const component of components) {
          if (component.endsWith(".app")) {
            bundleName = component.slice(0, -4);
            break;
          }
        }
      }

      // Read Manifest.plist
      if (!manifestData && filename.endsWith(".app/SC_Info/Manifest.plist")) {
        const stream = await entry.openReadStream();
        manifestData = await streamToBuffer(stream);
      }

      // Read Info.plist (non-Watch)
      if (
        !infoPlistData &&
        filename.includes(".app/Info.plist") &&
        !filename.includes("/Watch/")
      ) {
        const stream = await entry.openReadStream();
        infoPlistData = await streamToBuffer(stream);
        infoPlistDate = entry.getLastMod();
      }
    }

    if (!bundleName) {
      throw new Error("Could not read bundle name");
    }

    // Parse manifest
    let manifest: { sinfPaths: string[] } | null = null;
    if (manifestData) {
      const parsed = parsePlistBuffer(manifestData);
      if (parsed) {
        const sinfPaths = parsed["SinfPaths"];
        if (Array.isArray(sinfPaths)) {
          manifest = { sinfPaths: sinfPaths as string[] };
        }
      }
    }

    // Parse info plist
    let info: { bundleExecutable: string } | null = null;
    let infoPlist: Record<string, unknown> | null = null;
    if (infoPlistData) {
      const parsed = parsePlistBuffer(infoPlistData);
      if (parsed) {
        infoPlist = parsed;
        const executable = parsed["CFBundleExecutable"];
        if (typeof executable === "string") {
          info = { bundleExecutable: executable };
        }
      }
    }

    return {
      bundleName,
      manifest,
      info,
      infoPlist,
      infoPlistDate,
      storeMetadata: storeMetadataData
        ? parsePlistBuffer(storeMetadataData)
        : null,
      iconCandidates,
    };
  } finally {
    await zip.close();
  }
}

function iconCandidateForEntry(
  filename: string,
  entry: { uncompressedSize?: number },
): IconCandidate | null {
  const match = APP_ROOT_IMAGE_RE.exec(filename);
  if (!match) return null;

  const size = Number(entry.uncompressedSize) || 0;
  if (size > MAX_ICON_BYTES) return null;

  return { entryName: filename, name: match[1], size };
}

/**
 * Lifts the app icon out of the package, or nothing when the bundle carries no
 * usable image. The archive is reopened: the chosen entry depends on the
 * Info.plist the first pass was reading.
 */
async function readPackageIcon(
  ipaPath: string,
  bundleName: string,
  infoPlist: Record<string, unknown> | null,
  candidates: IconCandidate[],
): Promise<PackageIcon | undefined> {
  const chosen = selectIcon(candidates, infoPlist, bundleName);
  if (!chosen) return undefined;

  try {
    const data = await readArchiveEntry(ipaPath, chosen.entryName);
    if (!data || data.length === 0) return undefined;
    return { filename: chosen.name, data: toRenderableIcon(data) };
  } catch (err) {
    // An unusable icon must never fail a download that otherwise compiled.
    console.warn(
      `[sinfInjector] Could not read the app icon: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

/**
 * Apple repacks shipped icons with `pngcrush -iphone` into CgBI PNGs, which
 * only Safari decodes; in a browser they silently fail. Convert back to a
 * standard PNG. Anything else passes through.
 */
function toRenderableIcon(data: Buffer): Buffer {
  if (!isCgbiPng(data)) return data;

  const converted = convertCgbiToPng(data);
  if (!converted) {
    console.warn(
      "[sinfInjector] Could not convert a CgBI icon; browsers may not render it",
    );
    return data;
  }
  return converted;
}

async function readArchiveEntry(
  ipaPath: string,
  entryName: string,
): Promise<Buffer | null> {
  const zip = await openZip(ipaPath);
  try {
    for await (const entry of zip) {
      if (entry.filename !== entryName) continue;
      const stream = await entry.openReadStream();
      return await streamToBuffer(stream);
    }
    return null;
  } finally {
    await zip.close();
  }
}

/**
 * Picks which bundle image is the app icon — the largest loose icon at the root,
 * among Info.plist-declared or icon-named files only. Guessing would trade a
 * missing icon for a wrong one; returning nothing is deliberate.
 */
function selectIcon(
  candidates: IconCandidate[],
  infoPlist: Record<string, unknown> | null,
  bundleName: string,
): IconCandidate | null {
  const bundleRoot = `Payload/${bundleName}.app/`;
  const inBundle = candidates.filter((c) =>
    c.entryName.startsWith(bundleRoot),
  );
  if (inBundle.length === 0) return null;

  const declared = declaredIconNames(infoPlist);
  const pool =
    [
      inBundle.filter((candidate) => isDeclaredIcon(candidate.name, declared)),
      inBundle.filter((candidate) => ICON_HINT_RE.test(candidate.name)),
    ].find((group) => group.length > 0) ?? [];

  return [...pool].sort(compareIcons)[0] ?? null;
}

/** Largest first: by the point size in the file name, then by bytes. */
function compareIcons(a: IconCandidate, b: IconCandidate): number {
  return iconPoints(b.name) - iconPoints(a.name) || b.size - a.size;
}

/**
 * The pixel size encoded in an icon's name (`AppIcon60x60@2x` → 120). Names not
 * following the convention score zero and fall back to file size.
 */
function iconPoints(name: string): number {
  const match = /(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:@(\d)x)?/i.exec(name);
  if (!match) return 0;

  const base = Math.max(Number.parseFloat(match[1]), Number.parseFloat(match[2]));
  const scale = match[3] ? Number.parseFloat(match[3]) : 1;
  return base * scale;
}

interface DeclaredIconNames {
  /** Icon bases from `CFBundleIconFiles`, scale suffixes stripped. */
  bases: Set<string>;
  /** `CFBundleIconName`: an asset-catalogue name the loose files prefix-match. */
  prefix?: string;
}

/**
 * The icon names the Info.plist declares. Only the *primary* icon counts:
 * `CFBundleAlternateIcons` can list hundreds of theme alternates, which would
 * let any resource image pass for the icon.
 */
function declaredIconNames(
  infoPlist: Record<string, unknown> | null,
): DeclaredIconNames {
  const bases = new Set<string>();
  let prefix: string | undefined;

  if (infoPlist) {
    // `CFBundleIcons` and its iPad twin carry `CFBundlePrimaryIcon`; the legacy
    // layout puts the same keys at the top level.
    for (const node of [
      infoPlist["CFBundleIcons"],
      infoPlist["CFBundleIcons~ipad"],
      infoPlist,
    ]) {
      const record = asRecord(node);
      if (!record) continue;

      const primary = asRecord(record["CFBundlePrimaryIcon"]) ?? record;
      collectIconFiles(primary["CFBundleIconFiles"], bases);

      const name = primary["CFBundleIconName"];
      if (prefix === undefined && typeof name === "string" && name !== "") {
        prefix = name;
      }
    }
  }

  return { bases, prefix };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectIconFiles(node: unknown, bases: Set<string>, depth = 0): void {
  if (depth > 3 || !node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) {
      // `CFBundleIconFiles` is a list of names; anything else is a container.
      if (typeof item === "string") bases.add(iconBase(item));
      else collectIconFiles(item, bases, depth + 1);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  if (typeof record["CFBundleIconFiles"] !== "undefined") {
    collectIconFiles(record["CFBundleIconFiles"], bases, depth + 1);
  }
  if (typeof record["CFBundlePrimaryIcon"] !== "undefined") {
    collectIconFiles(record["CFBundlePrimaryIcon"], bases, depth + 1);
  }
}

function isDeclaredIcon(name: string, declared: DeclaredIconNames): boolean {
  if (declared.bases.size > 0 && declared.bases.has(iconBase(name))) {
    return true;
  }
  return Boolean(
    declared.prefix && name.toLowerCase().startsWith(declared.prefix.toLowerCase()),
  );
}

/** `AppIcon60x60@2x~ipad.png` → `AppIcon60x60`. */
function iconBase(name: string): string {
  return name
    .replace(/\.(?:png|jpe?g)$/i, "")
    .replace(/@\d+x$/i, "")
    .replace(/~[\w-]+$/i, "");
}

async function addFilesToZip(
  ipaPath: string,
  files: { entryPath: string; data: Buffer }[],
): Promise<void> {
  if (!(await hasZipCommand())) {
    await rewriteZipStreaming(ipaPath, files);
    return;
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sinf-"));
  const resolvedTmpDir = path.resolve(tmpDir);
  try {
    // Write files to temp dir preserving ZIP path structure
    const relativePaths: string[] = [];
    for (const file of files) {
      // Guard against path traversal from IPA-derived entry paths
      const fullPath = path.resolve(tmpDir, file.entryPath);
      if (!fullPath.startsWith(resolvedTmpDir + path.sep)) {
        throw new Error(`Path traversal detected in entry: ${file.entryPath}`);
      }
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, file.data);
      relativePaths.push(file.entryPath);
    }

    // In-place zip update: -0 stores uncompressed (SINF/plist are tiny); "--"
    // stops file args from being parsed as flags.
    await execFile("zip", ["-0", ipaPath, "--", ...relativePaths], {
      cwd: tmpDir,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

/** `zip` ships in the container image; a bare Windows host has to opt in. */
let zipCommandAvailable: Promise<boolean> | null = null;

function hasZipCommand(): Promise<boolean> {
  if (!zipCommandAvailable) {
    zipCommandAvailable = execFile("zip", ["-v"]).then(
      () => true,
      () => false,
    );
  }
  return zipCommandAvailable;
}

/**
 * Rewrites the archive with the built-in streaming writer, used only when no
 * `zip` command exists so a download fails for a real reason instead of
 * "spawn zip ENOENT". Entries are piped one at a time (yauzl → archiver), so
 * memory stays bounded regardless of package size — the old adm-zip writer's
 * 512 MB ceiling is gone.
 */
async function rewriteZipStreaming(
  ipaPath: string,
  files: { entryPath: string; data: Buffer }[],
): Promise<void> {
  console.warn(
    "[sinfInjector] `zip` not found on PATH; rewriting the IPA with the built-in streaming zip writer",
  );

  // Normalize and traversal-check entries up front; a name collision replaces
  // the existing archive entry.
  const injected = new Map<string, Buffer>();
  for (const file of files) {
    const normalized = path.posix.normalize(file.entryPath);
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("../")) {
      throw new Error(`Path traversal detected in entry: ${file.entryPath}`);
    }
    injected.set(normalized, file.data);
  }

  const rebuiltPath = `${ipaPath}.rebuild`;
  const source = await openZip(ipaPath);
  const output = fs.createWriteStream(rebuiltPath);
  const archive = new ZipArchive();
  archive.pipe(output);

  // Rejects on any archive/output error; resolves once the rebuilt file is
  // flushed.
  const settled = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });

  try {
    for await (const entry of source) {
      // Replaced entries are written fresh at the end, not copied through.
      if (injected.has(entry.filename)) continue;

      if (entry.filename.endsWith("/")) {
        archive.append(Buffer.alloc(0), {
          name: entry.filename,
          store: true,
          date: entry.getLastMod(),
          mode: unixModeOf(entry),
        });
        continue;
      }

      const stream = await entry.openReadStream();
      archive.append(stream, {
        name: entry.filename,
        store: !entry.isCompressed(),
        date: entry.getLastMod(),
        mode: unixModeOf(entry),
      });
      // One entry in flight: yauzl streams are sequential (bounded memory). The
      // race against `settled` stops a mid-rewrite error from hanging on an
      // undrained stream.
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          stream.on("end", resolve);
          stream.on("error", reject);
        }),
        settled,
      ]);
    }

    // Injected files go in uncompressed, matching the command path's `zip -0`.
    for (const [name, data] of injected) {
      archive.append(data, { name, store: true });
    }

    await archive.finalize();
    await settled;
    await source.close();
    fs.renameSync(rebuiltPath, ipaPath);
  } catch (err) {
    await source.close().catch(() => {});
    output.destroy();
    try {
      fs.rmSync(rebuiltPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/** Unix permission bits of a zip entry, when the archive recorded any. */
function unixModeOf(entry: Entry): number | undefined {
  // The high byte of versionMadeBy names the host system; 3 is Unix.
  if ((entry.versionMadeBy >> 8) !== 3) return undefined;
  return (entry.externalFileAttributes >>> 16) & 0o7777;
}

function parsePlistBuffer(data: Buffer): Record<string, unknown> | null {
  // Try binary plist first
  try {
    const parsed = bplistParser.parseBuffer(data);
    if (parsed && parsed.length > 0) {
      return parsed[0] as Record<string, unknown>;
    }
  } catch {
    // Not binary plist, try XML
  }

  // Try XML plist
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
