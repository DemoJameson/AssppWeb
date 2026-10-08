import { useEffect, useRef, useState } from "react";
import { useDownloadsStore } from "../store/downloads";
import { useAccounts } from "./useAccounts";
import { accountHash } from "../utils/account";

export function useDownloads() {
  const {
    tasks,
    loading,
    setAccountHashes,
    fetchTasks,
    startDownload,
    pauseDownload,
    resumeDownload,
    deleteDownload,
  } = useDownloadsStore();
  const { accounts } = useAccounts();
  const hashesRef = useRef("");
  const [hashToEmail, setHashToEmail] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Hashes in `accounts` order.
      const hashes = await Promise.all(accounts.map((a) => accountHash(a)));
      // slice() before sort() so the original order survives for the map below.
      const key = hashes.slice().sort().join(",");
      if (cancelled || key === hashesRef.current) return;
      hashesRef.current = key;

      const map: Record<string, string> = {};
      for (let i = 0; i < accounts.length; i++) {
        map[hashes[i]] = accounts[i].email;
      }
      setHashToEmail(map);

      setAccountHashes(hashes);
      // Fetch right after hashes are set so downloads appear on first visit.
      fetchTasks();
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts, setAccountHashes, fetchTasks]);

  return {
    tasks,
    loading,
    hashToEmail,
    fetchTasks,
    startDownload,
    pauseDownload,
    resumeDownload,
    deleteDownload,
  };
}
