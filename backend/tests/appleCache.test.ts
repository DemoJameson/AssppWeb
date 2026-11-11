import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "../src/config.js";
import {
  appleCacheDir,
  ensureAppleCache,
  helperCacheEnv,
  helperProcessEnv,
} from "../src/services/appleCache.js";

const tempDirectories: string[] = [];

function tempDir(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `asspp-${name}-`));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("appleCache", () => {
  it("resolves the helper cache to an absolute path", () => {
    const previousDataDir = config.dataDir;
    config.dataDir = "./data";

    try {
      expect(path.isAbsolute(appleCacheDir())).toBe(true);
    } finally {
      config.dataDir = previousDataDir;
    }
  });

  it("points the helper cache environment at the same directory", () => {
    const previousDataDir = config.dataDir;
    const data = tempDir("apple-data-env");
    config.dataDir = data;

    try {
      const cache = appleCacheDir();
      const env = helperCacheEnv();
      expect(env.XDG_CACHE_HOME).toBe(cache);
      if (process.platform === "darwin") {
        expect(env.HOME).toBe(path.dirname(path.dirname(cache)));
      } else if (process.platform === "win32") {
        expect(env.LOCALAPPDATA).toBe(cache);
      }
    } finally {
      config.dataDir = previousDataDir;
    }
  });

  it("keeps backend secrets out of the helper environment", () => {
    const previousSecret = process.env.ACCESS_PASSWORD;
    process.env.ACCESS_PASSWORD = "super-secret";

    try {
      const env = helperProcessEnv();
      expect(env.ACCESS_PASSWORD).toBeUndefined();
      if (process.env.PATH !== undefined) {
        expect(env.PATH).toBe(process.env.PATH);
      }
    } finally {
      if (previousSecret === undefined) delete process.env.ACCESS_PASSWORD;
      else process.env.ACCESS_PASSWORD = previousSecret;
    }
  });

  it("seeds the writable cache from the image-prebaked directory", async () => {
    const bundled = tempDir("apple-bundled");
    const data = tempDir("apple-data");
    const previousBundled = process.env.BUNDLED_APPLE_CACHE;
    const previousDataDir = config.dataDir;
    // Names the backend does not hardcode: the helper owns the cache layout.
    const sapVersion = "apple-assets-test-v9";
    const previousSapVersion = "apple-assets-test-v8";
    const unicornVersion = "9.9.9-test";

    fs.mkdirSync(path.join(bundled, "ipatool"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "ipatool", ".complete"), "");
    fs.mkdirSync(
      path.join(bundled, "ipatool", "sap", sapVersion),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(bundled, "ipatool", "sap", sapVersion, "AppleMediaServices"),
      "asset",
    );
    fs.mkdirSync(
      path.join(bundled, "ipatool", "sap", previousSapVersion),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        bundled,
        "ipatool",
        "sap",
        previousSapVersion,
        "AppleMediaServices",
      ),
      "previous-asset",
    );
    fs.mkdirSync(
      path.join(bundled, "ipatool", "unicorn", unicornVersion),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        bundled,
        "ipatool",
        "unicorn",
        unicornVersion,
        "libunicorn.so.2",
      ),
      "runtime",
    );

    process.env.BUNDLED_APPLE_CACHE = bundled;
    config.dataDir = data;
    const cache = appleCacheDir();

    try {
      await ensureAppleCache();

      expect(
        fs.existsSync(
          path.join(
            cache,
            "ipatool",
            "sap",
            sapVersion,
            "AppleMediaServices",
          ),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            cache,
            "ipatool",
            "sap",
            previousSapVersion,
            "AppleMediaServices",
          ),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            cache,
            "ipatool",
            "unicorn",
            unicornVersion,
            "libunicorn.so.2",
          ),
        ),
      ).toBe(true);
    } finally {
      config.dataDir = previousDataDir;
      if (previousBundled === undefined) delete process.env.BUNDLED_APPLE_CACHE;
      else process.env.BUNDLED_APPLE_CACHE = previousBundled;
    }
  });

  it("does nothing when the image has no complete marker", async () => {
    const bundled = tempDir("apple-incomplete");
    const data = tempDir("apple-data-incomplete");
    const previousBundled = process.env.BUNDLED_APPLE_CACHE;
    const previousDataDir = config.dataDir;

    process.env.BUNDLED_APPLE_CACHE = bundled;
    config.dataDir = data;
    const cache = appleCacheDir();

    try {
      await ensureAppleCache();
      expect(fs.existsSync(path.join(cache, "ipatool"))).toBe(false);
    } finally {
      config.dataDir = previousDataDir;
      if (previousBundled === undefined) delete process.env.BUNDLED_APPLE_CACHE;
      else process.env.BUNDLED_APPLE_CACHE = previousBundled;
    }
  });

  it("does not leave a partial cache when the copy is interrupted", async () => {
    const bundled = tempDir("apple-bundled-interrupted");
    const data = tempDir("apple-data-interrupted");
    const previousBundled = process.env.BUNDLED_APPLE_CACHE;
    const previousDataDir = config.dataDir;
    const sapVersion = "apple-assets-interrupted-v1";

    fs.mkdirSync(path.join(bundled, "ipatool", "sap", sapVersion), {
      recursive: true,
    });
    fs.writeFileSync(path.join(bundled, "ipatool", ".complete"), "");
    fs.writeFileSync(
      path.join(
        bundled,
        "ipatool",
        "sap",
        sapVersion,
        "AppleMediaServices",
      ),
      "asset",
    );

    process.env.BUNDLED_APPLE_CACHE = bundled;
    config.dataDir = data;
    const cache = appleCacheDir();
    const target = path.join(cache, "ipatool", "sap", sapVersion);
    const symlink = vi
      .spyOn(fs.promises, "symlink")
      .mockRejectedValue(new Error("symlinks unsupported"));
    const copy = vi
      .spyOn(fs.promises, "cp")
      .mockImplementation(async (_source, destination) => {
        const directory = String(destination);
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(path.join(directory, "partial"), "partial");
        throw new Error("copy interrupted");
      });

    try {
      await expect(ensureAppleCache()).rejects.toThrow("copy interrupted");
      expect(fs.existsSync(target)).toBe(false);
      expect(
        fs.readdirSync(path.join(cache, "ipatool", "sap")),
      ).toEqual([]);

      symlink.mockRestore();
      copy.mockRestore();
      await ensureAppleCache();
      expect(
        fs.existsSync(path.join(target, "AppleMediaServices")),
      ).toBe(true);
    } finally {
      config.dataDir = previousDataDir;
      if (previousBundled === undefined) delete process.env.BUNDLED_APPLE_CACHE;
      else process.env.BUNDLED_APPLE_CACHE = previousBundled;
    }
  });

  it("replaces a file occupying a seed target", async () => {
    const bundled = tempDir("apple-bundled-file");
    const data = tempDir("apple-data-file");
    const previousBundled = process.env.BUNDLED_APPLE_CACHE;
    const previousDataDir = config.dataDir;
    const sapVersion = "apple-assets-file-v1";

    fs.mkdirSync(path.join(bundled, "ipatool", "sap", sapVersion), {
      recursive: true,
    });
    fs.writeFileSync(path.join(bundled, "ipatool", ".complete"), "");
    fs.writeFileSync(
      path.join(
        bundled,
        "ipatool",
        "sap",
        sapVersion,
        "AppleMediaServices",
      ),
      "asset",
    );

    process.env.BUNDLED_APPLE_CACHE = bundled;
    config.dataDir = data;
    const target = path.join(
      appleCacheDir(),
      "ipatool",
      "sap",
      sapVersion,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "not a directory");

    try {
      await ensureAppleCache();
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(
        fs.readFileSync(path.join(target, "AppleMediaServices"), "utf8"),
      ).toBe("asset");
    } finally {
      config.dataDir = previousDataDir;
      if (previousBundled === undefined) delete process.env.BUNDLED_APPLE_CACHE;
      else process.env.BUNDLED_APPLE_CACHE = previousBundled;
    }
  });

  it.skipIf(process.platform === "win32")(
    "replaces a broken seed symlink",
    async () => {
      const bundled = tempDir("apple-bundled-broken-link");
      const data = tempDir("apple-data-broken-link");
      const previousBundled = process.env.BUNDLED_APPLE_CACHE;
      const previousDataDir = config.dataDir;
      const sapVersion = "apple-assets-broken-v1";

      fs.mkdirSync(path.join(bundled, "ipatool", "sap", sapVersion), {
        recursive: true,
      });
      fs.writeFileSync(path.join(bundled, "ipatool", ".complete"), "");
      fs.writeFileSync(
        path.join(
          bundled,
          "ipatool",
          "sap",
          sapVersion,
          "AppleMediaServices",
        ),
        "asset",
      );

      process.env.BUNDLED_APPLE_CACHE = bundled;
      config.dataDir = data;
      const target = path.join(
        appleCacheDir(),
        "ipatool",
        "sap",
        sapVersion,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(data, "missing-bundled-path"), target, "dir");

      try {
        await ensureAppleCache();
        expect(fs.statSync(target).isDirectory()).toBe(true);
        expect(
          fs.readFileSync(path.join(target, "AppleMediaServices"), "utf8"),
        ).toBe("asset");
      } finally {
        config.dataDir = previousDataDir;
        if (previousBundled === undefined) delete process.env.BUNDLED_APPLE_CACHE;
        else process.env.BUNDLED_APPLE_CACHE = previousBundled;
      }
    },
  );
});
