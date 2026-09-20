import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseHandle } from "better-sqlite3";

// The legacy-JSON migration is the one chunk of db.ts that only ever runs on
// an old instance's first boot, so it is easy for it to rot silently. Each case
// runs against its own scratch DATA_DIR with a freshly imported db module:
// `config.dataDir` is read once at import time, so the env is set before the
// dynamic import and the module registry is reset in between.
async function withDb<T>(
  dir: string,
  seed: (dir: string) => void,
  run: (db: DatabaseHandle) => T | Promise<T>,
): Promise<T> {
  process.env.DATA_DIR = dir;
  vi.resetModules();
  seed(dir);
  const { getDb, closeDb } = await import("../src/services/db.js");
  try {
    return await run(getDb() as DatabaseHandle);
  } finally {
    closeDb();
  }
}

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The only *.json files left in DATA_DIR after a migration should be none. */
function leakedJson(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
}

/** The columns a table actually has, in declaration order. */
function columns(db: DatabaseHandle, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

describe("schema upgrades", () => {
  it("adds the package-build columns a previous release shipped without", async () => {
    // What an instance created by the first SQLite release looks like: the
    // package index has no size/date columns, and the schema version is 1.
    const dir = scratch("asspp-upgrade-");
    await withDb(
      dir,
      (d) => {
        const old = new Database(path.join(d, "asspp.db"));
        old.exec(`
          CREATE TABLE package_apps (
            app_id        INTEGER PRIMARY KEY,
            bundle_id     TEXT NOT NULL,
            name          TEXT,
            artist_name   TEXT,
            artwork_url   TEXT,
            primary_genre TEXT,
            updated_at    INTEGER NOT NULL
          );
          CREATE TABLE package_app_builds (
            app_id      INTEGER NOT NULL,
            platform    TEXT NOT NULL,
            version     TEXT,
            minimum_os  TEXT,
            updated_at  INTEGER NOT NULL,
            PRIMARY KEY (app_id, platform)
          );
          PRAGMA user_version = 1;
        `);
        old
          .prepare(
            "INSERT INTO package_apps (app_id, bundle_id, name, updated_at) VALUES (42, 'com.example.legacy', 'Legacy', 1)",
          )
          .run();
        old
          .prepare(
            "INSERT INTO package_app_builds (app_id, platform, version, minimum_os, updated_at) VALUES (42, 'ios', '3.0.0', '15.0', 1)",
          )
          .run();
        old.close();
      },
      (db) => {
        // Appended by ALTER TABLE, so they land after `updated_at` — the order
        // differs from a fresh database's, which every query here is written to
        // survive (columns are always named).
        expect(columns(db, "package_app_builds")).toEqual(
          expect.arrayContaining([
            "app_id",
            "platform",
            "version",
            "minimum_os",
            "updated_at",
            "file_size",
            "release_date",
          ]),
        );
        expect(columns(db, "package_app_builds")).toHaveLength(7);
        // The recorded build survives the upgrade, with the new columns empty.
        expect(
          db
            .prepare(
              "SELECT app_id, platform, version, file_size, release_date FROM package_app_builds",
            )
            .all(),
        ).toEqual([
          {
            app_id: 42,
            platform: "ios",
            version: "3.0.0",
            file_size: null,
            release_date: null,
          },
        ]);
        expect(db.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 2,
        });
      },
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("leaves an already-upgraded database alone", async () => {
    const dir = scratch("asspp-upgrade-again-");
    await withDb(
      dir,
      () => {},
      (db) => {
        expect(columns(db, "package_app_builds")).toContain("file_size");
      },
    );
    // Second boot on the same file: the guarded ALTERs must not throw.
    await withDb(
      dir,
      () => {},
      (db) => {
        expect(columns(db, "package_app_builds")).toContain("release_date");
      },
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});

describe("migrateLegacyJsonFiles", () => {
  it("imports all four legacy JSON stores and renames the files aside", async () => {
    const dir = scratch("asspp-migrate-all-");
    await withDb(
      dir,
      (d) => {
        // One completed task plus one skipped (not completed / no software).
        fs.writeFileSync(
          path.join(d, "tasks.json"),
          JSON.stringify([
            {
              id: "t1",
              software: { id: 1, bundleID: "com.x", name: "X" },
              accountHash: "h1",
              filePath: "/a.ipa",
              status: "completed",
              hasIcon: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            { id: "t2", software: null, filePath: "/b.ipa", status: "failed" },
          ]),
        );
        fs.writeFileSync(
          path.join(d, "version-pins.json"),
          JSON.stringify({
            schema: 1,
            pins: { "6503940939": { tvos: { versionId: "888154622", updatedAt: 10 } } },
          }),
        );
        fs.writeFileSync(
          path.join(d, "version-metadata.json"),
          JSON.stringify({
            schema: 1,
            entries: {
              "6503940939": {
                "888154622": {
                  displayVersion: "1.3.18",
                  releaseDate: "2026-07-11T00:00:00.000Z",
                  seededAt: 5,
                },
              },
            },
          }),
        );
        fs.writeFileSync(
          path.join(d, "package-apps.json"),
          JSON.stringify({
            schema: 2,
            apps: {
              "6503940939": {
                bundleID: "com.example",
                name: "M",
                builds: { ios: { version: "4.8.2", updatedAt: 20 } },
                updatedAt: 20,
              },
            },
          }),
        );
      },
      (db) => {
        expect(db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: "t1" }]);
        expect(db.prepare("SELECT app_id, platform, version_id FROM version_pins").all()).toEqual([
          { app_id: 6503940939, platform: "tvos", version_id: "888154622" },
        ]);
        expect(db.prepare("SELECT app_id, version_id, source FROM version_metadata").all()).toEqual([
          { app_id: 6503940939, version_id: 888154622, source: "package" },
        ]);
        expect(db.prepare("SELECT app_id, bundle_id FROM package_apps").all()).toEqual([
          { app_id: 6503940939, bundle_id: "com.example" },
        ]);
        expect(db.prepare("SELECT app_id, platform, version FROM package_app_builds").all()).toEqual([
          { app_id: 6503940939, platform: "ios", version: "4.8.2" },
        ]);
        expect(leakedJson(dir)).toEqual([]);
      },
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("migrates a legacy schema-1 flat package-app record to its platform's build", async () => {
    const dir = scratch("asspp-migrate-flat-");
    await withDb(
      dir,
      (d) => {
        fs.writeFileSync(
          path.join(d, "package-apps.json"),
          JSON.stringify({
            schema: 1,
            apps: {
              "42": {
                bundleID: "com.example.legacy",
                name: "Legacy",
                platform: "macos",
                version: "3.0.0",
                updatedAt: 30,
              },
            },
          }),
        );
      },
      (db) => {
        expect(db.prepare("SELECT app_id, bundle_id FROM package_apps").all()).toEqual([
          { app_id: 42, bundle_id: "com.example.legacy" },
        ]);
        expect(db.prepare("SELECT app_id, platform, version FROM package_app_builds").all()).toEqual([
          { app_id: 42, platform: "macos", version: "3.0.0" },
        ]);
        expect(leakedJson(dir)).toEqual([]);
      },
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("renames a corrupted file aside and still migrates the rest", async () => {
    const dir = scratch("asspp-migrate-broken-");
    await withDb(
      dir,
      (d) => {
        fs.writeFileSync(path.join(d, "tasks.json"), "this is not json");
        fs.writeFileSync(
          path.join(d, "version-pins.json"),
          JSON.stringify({
            schema: 1,
            pins: { "6503940939": { ios: { versionId: "5", updatedAt: 1 } } },
          }),
        );
      },
      (db) => {
        // The valid store still migrated…
        expect(db.prepare("SELECT app_id, platform, version_id FROM version_pins").all()).toEqual([
          { app_id: 6503940939, platform: "ios", version_id: "5" },
        ]);
        // …and the broken file was renamed aside, not left to warn every boot.
        expect(fs.existsSync(path.join(dir, "tasks.json.broken"))).toBe(true);
        expect(leakedJson(dir)).toEqual([]);
      },
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});