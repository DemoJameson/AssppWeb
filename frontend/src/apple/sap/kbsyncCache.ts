// Account/device-bound kbsync cache. Kept apart from `client.ts` so account
// management can clear it without loading the SAP emulation or libcurl graph.

interface CachedKBSync {
  key: string;
  blob: string;
}

let cachedKBSync: CachedKBSync | null = null;

function kbsyncCacheKey(hardwareID: string, dsid: string): string {
  return `${hardwareID.toLowerCase()}:${Number(dsid)}`;
}

/** Returns the accepted blob for a matching account/device pair, if any. */
export function cachedDownloadKBSync(key: string): string | null {
  return cachedKBSync?.key === key ? cachedKBSync.blob : null;
}

/** Marks the blob Apple just served as reusable, after ent/download accepted it. */
export function acceptDownloadKBSync(
  hardwareID: string,
  dsid: string,
  blob: string,
): void {
  cachedKBSync = { key: kbsyncCacheKey(hardwareID, dsid), blob };
}

/** Forgets the cached blob for one account/device pair, e.g. when deleting the account. */
export function forgetDownloadKBSync(hardwareID: string, dsid: string): void {
  const key = kbsyncCacheKey(hardwareID, dsid);
  if (cachedKBSync?.key === key) {
    cachedKBSync = null;
  }
}

/** Drops a blob Apple rejected, so the next attempt regenerates it. */
export function invalidateDownloadKBSync(
  hardwareID: string,
  dsid: string,
  blob: string,
): void {
  const key = kbsyncCacheKey(hardwareID, dsid);
  if (cachedKBSync?.key === key && cachedKBSync.blob === blob) {
    cachedKBSync = null;
  }
}
