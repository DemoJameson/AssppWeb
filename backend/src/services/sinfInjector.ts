import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import AdmZip from "adm-zip";
import { open as openZip } from "yauzl-promise";
import type { Readable } from "stream";
import bplistParser from "bplist-parser";
import bplistCreator from "bplist-creator";
import plist from "plist";
import { convertCgbiToPng, isCgbiPng } from "./cgbiPng.js";
import type { Sinf } from "../types/index.js";

const execFile = promisify(execFileCb);

interface IpaMetadata {
  bundleName: string;
  manifest: { sinfPaths: string[] } | null;
  info: { bundleExecutable: string } | null;
  /** The app's parsed Info.plist, as declared by the package itself. */
  infoPlist: Record<string, unknown> | null;
  /**
   * The parsed `iTunesMetadata.plist` at the archive root, when a previous
   * injection wrote one. It carries what Apple said about the download.
   */
  storeMetadata: Record<string, unknown> | null;
  /** Images sitting at the top of the app bundle, any of which may be the icon. */
  iconCandidates: IconCandidate[];
}

/**
 * `Payload/<App>.app/<name>` — a file at the top of the app bundle. Requiring
 * exactly two slashes keeps icons of nested bundles (extensions, watch apps) out
 * of the running.
 */
const APP_ROOT_IMAGE_RE = /^Payload\/[^/]+\.app\/([^/]+\.(?:png|jpe?g))$/i;

/** Apple names the loose icon files it ships; nothing else at the root does. */
const ICON_HINT_RE = /^(?:app)?icon(?:[-_@.~]|\d|$)/i;

/**
 * A PNG of several megabytes sitting at the bundle root is artwork rather than
 * the app icon, and nothing downstream needs to move that much data around.
 */
const MAX_ICON_BYTES = 4 * 1024 * 1024;

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
   * Where Apple serves the app's icon. The download response carries it and the
   * injector writes it into the package, so it is available even for packages
   * that keep no icon of their own — a tvOS build ships its icon inside
   * Assets.car, which is not something worth parsing.
   */
  artworkURL?: string;
}

export interface InjectResult {
  /**
   * Metadata read out of the package: the app's Info.plist plus the
   * iTunesMetadata.plist written during injection. The package is the source of
   * truth for what it contains, which is what lets a download created from a
   * bare app id still report real values.
   */
  metadata: PackageMetadata;
  /**
   * The app's icon, when the bundle carries one. The App Store hands the icon
   * out to clients as a CDN URL, so a download that never saw storefront
   * metadata (a bare app id) has no other way to show one.
   */
  icon?: PackageIcon;
}

export async function inject(
  sinfs: Sinf[],
  ipaPath: string,
  iTunesMetadata?: string,
): Promise<InjectResult> {
  const { bundleName, manifest, info, infoPlist, iconCandidates } =
    await readIpaMetadata(ipaPath);

  // Read the icon before the archive is rewritten, so a package that fails to
  // yield one still compiles normally.
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

  // Inject iTunesMetadata.plist at the archive root if provided
  // Frontend sends base64-encoded XML plist; convert to binary plist
  // to match Apple's native format (PropertyListSerialization .binary)
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

  return { metadata: packageMetadata(storeMetadata, infoPlist), icon };
}

/**
 * Reads what an already compiled package can still tell us, without touching it:
 * the metadata Apple handed out with the download — which is where the icon URL
 * lives — and, when the bundle carries one, the icon itself. This is what fills
 * in a task that was compiled before any of this existed: recovering it costs a
 * few reads instead of downloading the app again.
 */
export async function readPackageInfo(
  ipaPath: string,
): Promise<{ metadata: PackageMetadata; icon?: PackageIcon }> {
  const { bundleName, infoPlist, storeMetadata, iconCandidates } =
    await readIpaMetadata(ipaPath);

  return {
    metadata: packageMetadata(storeMetadata, infoPlist),
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
 * Collects what the package says about the app. Apple's own store metadata
 * (the iTunesMetadata.plist the App Store hands out with a download) names the
 * app the way the storefront does, so it wins where both are available; the
 * Info.plist covers whatever the store metadata leaves out.
 */
function packageMetadata(
  store: Record<string, unknown> | null,
  infoPlist: Record<string, unknown> | null,
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
    releaseDate: firstString(store, ["releaseDate"]),
    artworkURL: sharperIconURL(
      firstString(store, ["softwareIcon57x57URL", "artworkURL"]),
    ),
  };
}

/**
 * mzstatic thumbnails carry the size they were requested at in the path
 * (`…/AppIcon…png/114x114bb.jpg`), and Apple sized this one for a 57pt slot —
 * soft in the 80px package view on a retina screen. The CDN renders any size on
 * demand, so ask for one with room to spare. A URL that does not look like one
 * of these is left alone rather than risked.
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
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readIpaMetadata(ipaPath: string): Promise<IpaMetadata> {
  const zip = await openZip(ipaPath);
  try {
    let bundleName: string | null = null;
    let manifestData: Buffer | null = null;
    let infoPlistData: Buffer | null = null;
    let storeMetadataData: Buffer | null = null;
    const iconCandidates: IconCandidate[] = [];

    for await (const entry of zip) {
      const filename = entry.filename;

      // The store metadata this package was built with, written by a previous
      // injection. Reading it back is how an already compiled package reports
      // what Apple said about the app, icon included.
      if (!storeMetadataData && filename === "iTunesMetadata.plist") {
        const stream = await entry.openReadStream();
        storeMetadataData = await streamToBuffer(stream);
      }

      // Collect the images that could be the app icon. Choosing among them
      // needs the Info.plist, so this only gathers what the archive lists.
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
 * usable image. The archive is opened again: which entry is the icon depends on
 * the Info.plist, which the first pass was reading at the same time.
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
 * Apple repacks the icons it ships with `pngcrush -iphone`, and the result
 * (a CgBI PNG) is only decodable by Safari. Handing one to a browser means the
 * image silently fails and the UI shows a placeholder, so convert it back to a
 * standard PNG. Anything else is already renderable and passes straight through.
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
 * Picks which of the bundle's images is the app icon. Apple ships the icon as a
 * set of loose files at the bundle root (`AppIcon60x60@2x.png` and friends), so
 * the largest one is the best source: it downsamples cleanly, which is what the
 * install manifest and the download list both need.
 *
 * Only two kinds of file are considered: those the Info.plist names as the
 * primary icon, and those named like an icon (`AppIcon…`, `Icon-60@2x`). The
 * bundle root of a real app is full of unrelated artwork — one shipping app puts
 * hundreds of numbered resource images there — so anything else is left alone.
 * Guessing among those would trade a missing icon for a wrong one, and the
 * caller has a storefront icon to fall back on. Returning nothing is deliberate.
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
 * The pixel size Apple encodes in an icon's name — `AppIcon60x60@2x` is a
 * 120-point icon. Names that do not follow the convention score zero and fall
 * back to comparing file sizes.
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
 * The icon names the Info.plist declares as the app's own.
 *
 * Only the *primary* icon counts. `CFBundleAlternateIcons` lists the alternates
 * a user can choose, and apps that offer themes register hundreds of them — one
 * shipping app files its entire skin catalogue there — so treating those as
 * candidates would let any resource image in the bundle pass for the icon.
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
      // `CFBundleIconFiles` is a list of names; anything else in there is a
      // container to walk.
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
    rewriteWithAdmZip(ipaPath, files);
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

    // Use zip to update the archive in-place
    // -0: store without compression (SINF/plist files are tiny)
    // "--" after archive name prevents file args from being parsed as flags
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
 * Upper bound for the in-process writer: adm-zip rewrites the whole archive in
 * memory, which is exactly why upstream moved to the `zip` command for large
 * packages. Refuse rather than risk an OOM on a huge IPA.
 */
const MAX_IN_PROCESS_ARCHIVE_BYTES = 512 * 1024 * 1024;

/**
 * Rewrites the archive with the bundled zip writer. Only used when no `zip`
 * command exists, so that a download fails for a real reason instead of
 * "spawn zip ENOENT".
 */
function rewriteWithAdmZip(
  ipaPath: string,
  files: { entryPath: string; data: Buffer }[],
): void {
  const { size } = fs.statSync(ipaPath);
  if (size > MAX_IN_PROCESS_ARCHIVE_BYTES) {
    throw new Error(
      `Package is ${Math.round(size / 1024 / 1024)} MB and no \`zip\` command is available; install zip or run the container image for packages this large`,
    );
  }

  console.warn(
    "[sinfInjector] `zip` not found on PATH; rewriting the IPA with the built-in zip writer",
  );

  const archive = new AdmZip(ipaPath);
  for (const file of files) {
    const normalized = path.posix.normalize(file.entryPath);
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("../")) {
      throw new Error(`Path traversal detected in entry: ${file.entryPath}`);
    }

    if (archive.getEntry(file.entryPath)) {
      archive.updateFile(file.entryPath, file.data);
    } else {
      archive.addFile(file.entryPath, file.data);
    }
  }

  // adm-zip appends `.zip` to a target name that lacks the extension.
  const rewritten = `${ipaPath}.tmp.zip`;
  archive.writeZip(rewritten);
  fs.renameSync(rewritten, ipaPath);
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
