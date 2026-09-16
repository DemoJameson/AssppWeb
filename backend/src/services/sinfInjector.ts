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
import type { Sinf } from "../types/index.js";

const execFile = promisify(execFileCb);

interface IpaMetadata {
  bundleName: string;
  manifest: { sinfPaths: string[] } | null;
  info: { bundleExecutable: string } | null;
  /** `CFBundleIdentifier` as declared by the package itself. */
  bundleIdentifier?: string;
}

export interface InjectResult {
  /**
   * The bundle identifier the package declares. The IPA is the source of truth
   * for it, which is what lets a download created from a bare app id still end
   * up with a usable install manifest.
   */
  bundleID?: string;
}

export async function inject(
  sinfs: Sinf[],
  ipaPath: string,
  iTunesMetadata?: string,
): Promise<InjectResult> {
  const { bundleName, manifest, info, bundleIdentifier } =
    await readIpaMetadata(ipaPath);

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
  if (iTunesMetadata) {
    const xmlBuffer = Buffer.from(iTunesMetadata, "base64");
    const xmlString = xmlBuffer.toString("utf-8");
    let metadataBuffer: Buffer;
    try {
      const parsed = plist.parse(xmlString);
      metadataBuffer = bplistCreator(parsed as Record<string, unknown>);
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

  return { bundleID: bundleIdentifier };
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

    for await (const entry of zip) {
      const filename = entry.filename;

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
    let bundleIdentifier: string | undefined;
    if (infoPlistData) {
      const parsed = parsePlistBuffer(infoPlistData);
      if (parsed) {
        const executable = parsed["CFBundleExecutable"];
        if (typeof executable === "string") {
          info = { bundleExecutable: executable };
        }

        const identifier = parsed["CFBundleIdentifier"];
        if (typeof identifier === "string" && identifier !== "") {
          bundleIdentifier = identifier;
        }
      }
    }

    return { bundleName, manifest, info, bundleIdentifier };
  } finally {
    await zip.close();
  }
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
