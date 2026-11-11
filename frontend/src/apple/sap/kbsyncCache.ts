// Account/device-bound kbsync cache. Kept apart from `client.ts` so account
// management can clear it without loading the SAP emulation or libcurl graph.
//
// The accepted blob is persisted in IndexedDB, mirroring ipatool's keychain /
// account-file cache: a page reload must not pay another StoreAgent run. Only a
// blob Apple has accepted is written; a generated-but-rejected blob is never
// treated as reusable.

import { openDB, type IDBPDatabase } from "idb";

interface CachedKBSync {
  key: string;
  blob: string;
}

const DB_NAME = "asspp-kbsync";
const STORE_NAME = "blobs";
/**
 * The cache is an optimization; an IndexedDB that is blocked behind a
 * versionchange or a stuck open must not hold a download or account operation
 * forever. Five seconds is enough for a healthy local read/write.
 */
export const KBSYNC_CACHE_TIMEOUT_MS = 5_000;

let cachedKBSync: CachedKBSync | null = null;
let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    const opening = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      },
    }).catch((error) => {
      // A rejected open is not a usable cache either; let the next caller try
      // again instead of reusing the rejected promise for the page session.
      if (dbPromise === opening) dbPromise = null;
      throw error;
    });
    dbPromise = opening;
  }
  return dbPromise;
}

function withCacheTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = KBSYNC_CACHE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // A blocked open must not become the promise every later call joins.
      dbPromise = null;
      reject(new Error("kbsync cache storage timed out"));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(operation), deadline])
    .catch((error) => {
      // Any storage failure may mean this connection is unusable (a
      // versionchange in another tab closes it). The cache is an optimisation,
      // so the next caller should open a fresh connection instead of inheriting
      // the failed one and silently regenerating every kbsync.
      dbPromise = null;
      throw error;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function kbsyncCacheKey(hardwareID: string, dsid: string): string {
  return `${hardwareID.toLowerCase()}:${Number(dsid)}`;
}

/**
 * Returns the accepted blob for a matching account/device pair, if any. The
 * in-memory copy is checked first; IndexedDB covers a page reload.
 */
export async function loadDownloadKBSync(
  hardwareID: string,
  dsid: string,
): Promise<string | null> {
  const key = kbsyncCacheKey(hardwareID, dsid);
  if (cachedKBSync?.key === key) return cachedKBSync.blob;

  try {
    const entry = await withCacheTimeout(async () => {
      const db = await getDB();
      return (await db.get(STORE_NAME, key)) as CachedKBSync | undefined;
    });
    if (entry?.key === key && typeof entry.blob === "string" && entry.blob) {
      cachedKBSync = entry;
      return entry.blob;
    }
  } catch (error) {
    console.warn("[kbsync] failed to read cached blob", error);
  }
  return null;
}

/** Marks the blob Apple just served as reusable, after ent/download accepted it. */
export async function acceptDownloadKBSync(
  hardwareID: string,
  dsid: string,
  blob: string,
): Promise<void> {
  const entry = { key: kbsyncCacheKey(hardwareID, dsid), blob };
  cachedKBSync = entry;
  try {
    await withCacheTimeout(async () => {
      const db = await getDB();
      await db.put(STORE_NAME, entry);
    });
  } catch (error) {
    console.warn("[kbsync] failed to persist accepted blob", error);
  }
}

/** Forgets the cached blob for one account/device pair, e.g. when deleting the account. */
export async function forgetDownloadKBSync(
  hardwareID: string,
  dsid: string,
): Promise<void> {
  const key = kbsyncCacheKey(hardwareID, dsid);
  if (cachedKBSync?.key === key) {
    cachedKBSync = null;
  }
  try {
    await withCacheTimeout(async () => {
      const db = await getDB();
      await db.delete(STORE_NAME, key);
    });
  } catch (error) {
    console.warn("[kbsync] failed to remove cached blob", error);
  }
}

/** Drops a blob Apple rejected, so the next attempt regenerates it. */
export async function invalidateDownloadKBSync(
  hardwareID: string,
  dsid: string,
  blob: string,
): Promise<void> {
  const key = kbsyncCacheKey(hardwareID, dsid);
  if (cachedKBSync?.key === key && cachedKBSync.blob === blob) {
    cachedKBSync = null;
  }
  try {
    await withCacheTimeout(async () => {
      const db = await getDB();
      const entry = (await db.get(STORE_NAME, key)) as
        | CachedKBSync
        | undefined;
      // A concurrent request may have cached a different account or a newer blob;
      // only remove the exact entry the failed request used.
      if (entry?.key === key && entry.blob === blob) {
        await db.delete(STORE_NAME, key);
      }
    });
  } catch (error) {
    console.warn("[kbsync] failed to invalidate cached blob", error);
  }
}

/** Test hook: clears the in-memory and IndexedDB copies. */
export async function clearDownloadKBSyncCache(): Promise<void> {
  cachedKBSync = null;
  try {
    await withCacheTimeout(async () => {
      const db = await getDB();
      await db.clear(STORE_NAME);
    });
  } catch {
    // Ignore — the in-memory copy is already gone.
  }
}
