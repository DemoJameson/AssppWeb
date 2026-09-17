import { useCallback, useState } from "react";
import { fetchVersionMetadata } from "../api/versionMetadata";
import type { VersionMetadata } from "../types";

/**
 * Per-page store for cached version metadata. `ensureLoaded` pulls the
 * backend's shared cache once a version list has loaded; `putEntry` records a
 * single metadata the page fetched from Apple itself (page-session only —
 * nothing is written back to the server). Neither call ever rejects.
 */
export function useVersionMetadataMap() {
  const [versionMeta, setVersionMeta] = useState<Record<string, VersionMetadata>>(
    {},
  );

  const putEntry = useCallback(
    (versionId: string, metadata: VersionMetadata) => {
      setVersionMeta((prev) =>
        prev[versionId] ? prev : { ...prev, [versionId]: metadata },
      );
    },
    [],
  );

  const ensureLoaded = useCallback(async (appId: string | number) => {
    const entries = await fetchVersionMetadata(appId);
    if (Object.keys(entries).length === 0) return;
    // Cached-first: an entry already on screen is never replaced.
    setVersionMeta((prev) => ({ ...entries, ...prev }));
  }, []);

  return { versionMeta, putEntry, ensureLoaded };
}
