import { openDB, type IDBPDatabase } from "idb";

/**
 * The opaque Anisette provisioning state is a per-device secret, not an Apple
 * account credential. It lives beside the accounts so a reload or 2FA retry
 * does not repeat machine provisioning. The backend never stores it.
 */

const DB_NAME = "asspp-anisette";
const STORE_NAME = "states";
export const ANISETTE_STATE_TIMEOUT_MS = 10_000;

interface AnisetteStateRecord {
  deviceIdentifier: string;
  state: string;
  updatedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * The latest state this tab has produced. It is normally read back from
 * IndexedDB, but an SP action needs exactly the state the helper just returned:
 * a blocked write must not turn that into a missing-state failure.
 */
const memoryStates = new Map<string, string>();
/** Devices whose last write failed; these read the in-memory state first. */
const memoryFallbacks = new Set<string>();

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    const opening = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "deviceIdentifier" });
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

/**
 * IndexedDB requests can stay pending behind a versionchange or a long-running
 * transaction. The Anisette state is an opaque provisioning blob: a blocked
 * read must fall back rather than hold up sign-in or a download forever, and a
 * failed write still leaves the latest value in memory for the SP action.
 */
function withStateTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Drop the blocked open as well; the next caller gets a fresh attempt.
      dbPromise = null;
      reject(new Error("Anisette state storage timed out"));
    }, ANISETTE_STATE_TIMEOUT_MS);
  });

  return Promise.race([Promise.resolve().then(operation), deadline])
    .catch((error) => {
      // Any storage failure may mean this connection is unusable; the next
      // caller should try a fresh open rather than inherit the failed promise.
      dbPromise = null;
      throw error;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

export async function getAnisetteState(
  deviceIdentifier: string,
): Promise<string | undefined> {
  if (!deviceIdentifier) return undefined;

  // A failed write left the only usable copy here. Reading IndexedDB first
  // would either wait out the same failure again or return the stale previous
  // state instead of the one Apple's SP action is waiting for.
  if (memoryFallbacks.has(deviceIdentifier)) {
    return memoryStates.get(deviceIdentifier);
  }

  try {
    const record = await withStateTimeout(async () => {
      const db = await getDB();
      return (await db.get(
        STORE_NAME,
        deviceIdentifier,
      )) as AnisetteStateRecord | undefined;
    });
    if (record?.state) {
      memoryStates.set(deviceIdentifier, record.state);
      return record.state;
    }
    memoryStates.delete(deviceIdentifier);
    return undefined;
  } catch (error) {
    console.warn("[anisette] could not read provisioning state", error);
    return memoryStates.get(deviceIdentifier);
  }
}

export async function setAnisetteState(
  deviceIdentifier: string,
  state: string,
): Promise<void> {
  if (!deviceIdentifier || !state) return;

  memoryStates.set(deviceIdentifier, state);
  try {
    await withStateTimeout(async () => {
      const db = await getDB();
      await db.put(STORE_NAME, {
        deviceIdentifier,
        state,
        updatedAt: Date.now(),
      } satisfies AnisetteStateRecord);
    });
    memoryFallbacks.delete(deviceIdentifier);
  } catch (error) {
    // Keep the produced state in memory: the SP action needs it even when
    // persistence fails. A later successful write clears the fallback.
    memoryFallbacks.add(deviceIdentifier);
    console.warn(
      "[anisette] could not save provisioning state; keeping it in memory",
      error,
    );
  }
}

export async function clearAnisetteState(
  deviceIdentifier: string,
): Promise<void> {
  if (!deviceIdentifier) return;

  memoryStates.delete(deviceIdentifier);
  memoryFallbacks.delete(deviceIdentifier);
  try {
    await withStateTimeout(async () => {
      const db = await getDB();
      await db.delete(STORE_NAME, deviceIdentifier);
    });
  } catch (error) {
    console.warn("[anisette] could not clear provisioning state", error);
  }
}
