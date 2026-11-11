import fs from "fs";
import path from "path";
import { config } from "../config.js";

/**
 * Where a release image prebakes the macOS 27 assets and, when present, the
 * Unicorn runtime. The marker is written only after a complete verified cache,
 * so a partial build directory is never treated as ready.
 */
export function bundledAppleCacheDir(): string {
  return process.env.BUNDLED_APPLE_CACHE ?? "/opt/asspp/apple-cache";
}

/**
 * The writable cache both helpers use. It lives on the data volume, so a
 * container replacement does not download Apple's assets again. The path
 * mirrors what Go's os.UserCacheDir resolves from the environment:
 * XDG_CACHE_HOME on Linux, HOME/Library/Caches on macOS, and LocalAppData on
 * Windows. The last two ignore XDG_CACHE_HOME.
 */
export function appleCacheDir(): string {
  // The default DATA_DIR is relative ("./data"); resolve to an absolute path
  // because both XDG_CACHE_HOME and the helper's cache lookup require one.
  if (process.platform === "darwin") {
    return path.resolve(config.dataDir, "apple-home", "Library", "Caches");
  }
  if (process.platform === "win32") {
    return path.resolve(config.dataDir, "apple-cache");
  }
  return path.resolve(config.dataDir, "cache");
}

/** Environment that makes the Go helpers' os.UserCacheDir resolve to appleCacheDir. */
export function helperCacheEnv(): NodeJS.ProcessEnv {
  const cache = appleCacheDir();
  const env: NodeJS.ProcessEnv = { XDG_CACHE_HOME: cache };
  if (process.platform === "darwin") {
    // os.UserCacheDir ignores XDG_CACHE_HOME on darwin and uses
    // $HOME/Library/Caches, so point HOME at a synthetic home whose Caches
    // directory is the cache above.
    env.HOME = path.dirname(path.dirname(cache));
  } else if (process.platform === "win32") {
    env.LOCALAPPDATA = cache;
  }
  return env;
}

/**
 * The environment a helper needs to run and reach Apple, without the backend's
 * secrets. `ACCESS_PASSWORD` and the rest of the server configuration stay out:
 * the helper runs Apple's emulated binaries and has network access.
 */
const HELPER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function helperProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Seeds the writable cache from the image-prebaked copy. The versioned directory
 * names are discovered from the bundle (the helper wrote them) rather than
 * repeated here, so bumping the pinned ipatool version cannot silently point the
 * seed at a directory the helper never reads. A missing Unicorn runtime is still
 * downloaded into the writable cache on first use.
 */
export async function ensureAppleCache(): Promise<void> {
  const bundled = bundledAppleCacheDir();
  const cache = appleCacheDir();

  try {
    await fs.promises.access(path.join(bundled, "ipatool", ".complete"));
  } catch {
    return;
  }

  for (const version of await childDirectoryNames(
    path.join(bundled, "ipatool", "sap"),
  )) {
    await seedDirectory(bundled, cache, path.join("ipatool", "sap", version));
  }
  for (const version of await childDirectoryNames(
    path.join(bundled, "ipatool", "unicorn"),
  )) {
    await seedDirectory(
      bundled,
      cache,
      path.join("ipatool", "unicorn", version),
    );
  }
}

/** Versioned subdirectories in a prebaked cache root; missing roots are empty. */
async function childDirectoryNames(root: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

async function seedDirectory(
  bundledRoot: string,
  cacheRoot: string,
  relative: string,
): Promise<void> {
  const target = path.join(cacheRoot, relative);
  if (await prepareSeedTarget(target)) return;

  const source = path.resolve(bundledRoot, relative);
  if (!(await exists(source))) return;

  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  try {
    await fs.promises.symlink(
      source,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // Another helper may have seeded the same directory between our check and
    // the symlink; that is success, not a reason to copy over it. A broken
    // link or a file at the target is not success: remove it and copy.
    if (await prepareSeedTarget(target)) return;

    // A volume that cannot carry symlinks still gets the assets; this is the
    // one-time cost of copying the prebaked files.
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    try {
      await fs.promises.cp(source, temporary, { recursive: true });
      try {
        await fs.promises.rename(temporary, target);
      } catch (error) {
        // Another process may have installed the target between our check and
        // the rename. Only then is an existing target a successful seed.
        if (await prepareSeedTarget(target)) {
          await fs.promises
            .rm(temporary, { recursive: true, force: true })
            .catch(() => undefined);
          return;
        }
        throw error;
      }
    } catch (error) {
      await fs.promises
        .rm(temporary, { recursive: true, force: true })
        .catch(() => undefined);
      // A concurrent helper may have completed the target while this copy was
      // failing; that is a successful seed, not a reason to fail the caller.
      if (await prepareSeedTarget(target)) return;
      throw error;
    }
  }
}

/**
 * Whether the cache target is already a directory, removing anything that
 * cannot become one. A symlink may point at a bundled path that an image or a
 * BUNDLED_APPLE_CACHE change removed; `fs.access` would call that missing and
 * leave the broken link behind, and a later rename over it fails with ENOTDIR.
 */
async function prepareSeedTarget(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink()) {
      try {
        const resolved = await fs.promises.stat(target);
        if (resolved.isDirectory()) return true;
      } catch {
        // Broken or non-directory target; remove the link below.
      }
      await fs.promises.rm(target, { force: true });
      return false;
    }

    if (stat.isDirectory()) return true;

    // A regular file where a cache directory belongs is invalid too.
    await fs.promises.rm(target, { force: true });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
