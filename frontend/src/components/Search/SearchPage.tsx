import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import CountrySelect from "../common/CountrySelect";
import PlatformSelect from "../common/PlatformSelect";
import StableLabel from "../common/StableLabel";

import { useSearch } from "../../hooks/useSearch";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useVersionMetadataMap } from "../../hooks/useVersionMetadata";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import {
  ensureVersionList,
  getCachedVersionList,
  useVersionListsStore,
  versionListKey,
} from "../../store/versionLists";
import { accountStoreCountry, firstAccountCountry } from "../../utils/account";
import {
  displayPrice,
  needsFetchVerification,
  needsVersionExchange,
} from "../../utils/software";
import { appPresenceFromProbeError } from "../../apple/errors";
import { getErrorMessage } from "../../utils/error";
import { countryCodeMap, storeIdToCountry } from "../../apple/config";

/**
 * What the version exchange said about a bare App ID — the only thing that can
 * decide whether the number names an app at all. `resolved` means versions came
 * back, so the record behaves like any other result.
 */
type ProbeState =
  | { status: "checking" }
  | { status: "resolved" }
  | { status: "unresolved"; note: string };

function sameProbeState(a: ProbeState | undefined, b: ProbeState): boolean {
  if (!a || a.status !== b.status) return false;
  if (a.status !== "unresolved" || b.status !== "unresolved") return true;
  return a.note === b.note;
}

export default function SearchPage() {
  const { t } = useTranslation();
  const { defaultCountry, defaultPlatform } = useSettingsStore();
  const { listVersionsWithLicense } = useDownloadAction();
  const [versionId, setVersionId] = useState("");
  const versionIdRef = useRef("");
  const versionIdValid =
    versionId.trim() === "" || /^\d+$/.test(versionId.trim());
  const prefetchedRef = useRef<Set<string>>(new Set());
  /** False once the page is gone: a settled probe must not touch state. */
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-armed on setup, not only cleared on cleanup: React StrictMode runs
    // setup → cleanup → setup on mount, and the cleanup's `false` must not
    // survive into the second run (it would mute every settled probe).
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** Probe state per bare App ID, keyed by app id. */
  const [probes, setProbes] = useState<Record<number, ProbeState>>({});
  const { accounts } = useAccounts();
  const { versionMeta, fillVersionsSilently } = useVersionMetadataMap();
  // Subscribed rather than read once: the newest version's label arrives after
  // the probe, and the cards re-render with it.
  const versionLists = useVersionListsStore((s) => s.lists);
  const initialCountry = firstAccountCountry(accounts) ?? defaultCountry;
  const addToast = useToastStore((s) => s.addToast);

  const {
    term,
    country,
    platform,
    results,
    loading,
    error,
    searched,
    search,
    setSearchParam,
    dropResult,
  } = useSearch();

  useEffect(() => {
    if (error) {
      addToast(error, "error");
    }
  }, [error, addToast]);

  useEffect(() => {
    if (!country && initialCountry) setSearchParam({ country: initialCountry });
    if (!platform && defaultPlatform) setSearchParam({ platform: defaultPlatform });
  }, [country, initialCountry, platform, defaultPlatform, setSearchParam]);

  const activeCountry = country || initialCountry;
  const activePlatform = platform || defaultPlatform;
  /**
   * The dimension the current probe states were asked in. A region switch
   * makes them stale — the same id may be fetchable from one storefront and
   * not another — and so does a platform switch: a different platform's
   * exchange is a different question. Either way the states are dropped and
   * the cards are re-asked (the list cache alone never re-settles across
   * dimensions; its keys are region-scoped too).
   */
  const probedDimensionRef = useRef({
    country: activeCountry,
    platform: activePlatform,
  });
  /**
   * The dimension currently on screen. An exchange settling for another region
   * or platform concluded nothing for this one — it must not settle it, and
   * its slot is freed so a return re-asks.
   */
  const viewRef = useRef({ country: activeCountry, platform: activePlatform });
  viewRef.current = { country: activeCountry, platform: activePlatform };

  /**
   * Records what the version exchange said about a bare App ID. Equal states
   * keep their identity: the probe effect re-runs on every render (its action
   * identities are fresh each time), and a new object would re-render forever.
   */
  function settleProbe(id: number, state: ProbeState) {
    setProbes((probes) =>
      sameProbeState(probes[id], state) ? probes : { ...probes, [id]: state },
    );
  }

  // A record the storefront does not carry — a delisted app, or a bare App ID
  // nothing knows — gets its version list fetched as soon as the search resolves
  // it, before the detail view is entered, so 选择版本 can open from the cache.
  //
  // For a record without evidence for the platform on screen — a bare App ID,
  // or a package-index record that only covers another platform — the same
  // exchange is also the only thing left that can say whether anything is
  // fetchable here: the storefront has no record of it and this server never
  // downloaded a build for this platform. Apple reporting nothing to serve
  // drops a bare id (the search reports a real miss instead of offering an id
  // that can never be fetched) and leaves a package-index record in place with
  // its reason — that record is proof the app exists, just not for this
  // platform. A failure about the session or the transport concludes nothing,
  // and the card says why it could not be settled.
  //
  // The verification is region-scoped: a region switch re-runs it with that
  // region's account, because the same id may be fetchable from one storefront
  // and not another — the shared list cache alone never re-settles a record
  // across regions.
  useEffect(() => {
    // Dimension switch (region or platform): every verdict was asked of the
    // old storefront/platform pair, so none of them carries over. Dropping the
    // states re-opens the cards and re-asks below.
    const dimension = probedDimensionRef.current;
    if (dimension.country !== activeCountry || dimension.platform !== activePlatform) {
      probedDimensionRef.current = {
        country: activeCountry,
        platform: activePlatform,
      };
      // The prefetch markers are dimension-scoped too: dropping the verdicts
      // must also drop the "already asked" markers, or a quick switch away and
      // back leaves a clickable-but-unverified card — the probe state is gone
      // while the marker still blocks the re-fetch.
      prefetchedRef.current.clear();
      if (Object.keys(probes).length > 0) {
        setProbes({});
        return;
      }
    }

    // A record whose region-scoped cache already holds a list needs no
    // exchange: that list was fetched by this region's account, which is the
    // settlement.
    for (const app of results) {
      if (!needsFetchVerification(app)) continue;
      if (probes[app.id]?.status === "resolved") continue;
      if (
        getCachedVersionList(
          versionListKey(app.id, activePlatform, activeCountry),
        )
      ) {
        settleProbe(app.id, { status: "resolved" });
      }
    }

    // One exchange at a time, for the first record that still needs one: its
    // region cache is empty and — for a record that must be verified — no
    // verdict exists yet. Records already checking/resolved/unresolved keep
    // their state, and rows not probed yet stay open; entering the detail view
    // verifies them there.
    const fetchable = results.find((app) => {
      if (!needsVersionExchange(app)) return false;
      const key = versionListKey(app.id, activePlatform, activeCountry);
      if (getCachedVersionList(key)) return false;
      return needsFetchVerification(app)
        ? probes[app.id] === undefined
        : !prefetchedRef.current.has(key);
    });
    if (!fetchable) return;
    // The records this exchange has to settle: a bare App ID, or a package-index
    // record that only ever covered *another* platform (an iOS build asked for
    // as tvOS) — its evidence does not reach the platform on screen. A record
    // whose own platform was recorded needs no settling: it came with it.
    const verify = needsFetchVerification(fetchable);
    const bare = fetchable.metadataSource === "bare";
    const key = versionListKey(fetchable.id, activePlatform, activeCountry);
    // Region-scoped key: each region gets its own slot, so its verification
    // runs for real and its exchange is never confused with one asked from
    // another storefront.
    if (prefetchedRef.current.has(key)) return;
    const account = accounts[0];
    // A verified record has to be asked about from the storefront the user
    // searched: any other account answers "Account Not In This Store", which
    // says nothing about the app. Without one there is nothing to ask with at
    // all.
    const regionAccount = accounts.find(
      (candidate) => accountStoreCountry(candidate) === activeCountry,
    );
    if (verify && !regionAccount) {
      settleProbe(fetchable.id, {
        status: "unresolved",
        note:
          accounts.length > 0
            ? t("search.product.noRegionAccount")
            : t("search.bareNoAccount"),
      });
      return;
    }
    if (!account) return;
    prefetchedRef.current.add(key);
    const pin = versionIdRef.current.trim();
    const target = { ...fetchable, platform: activePlatform };
    const probeAccount = regionAccount ?? account;
    const probeRegion = activeCountry;
    const probePlatform = activePlatform;
    if (verify) settleProbe(fetchable.id, { status: "checking" });
    void ensureVersionList(key, () =>
      listVersionsWithLicense(
        probeAccount,
        target,
        /^\d+$/.test(pin) ? pin : undefined,
      ),
    )
      .then((versions) => {
        // The exchange has no abort, so leaving mid-flight cannot call it off —
        // but nothing of it lands on a page that is gone.
        if (!mountedRef.current) return;
        if (verify) {
          const view = viewRef.current;
          if (view.country !== probeRegion || view.platform !== probePlatform) {
            // The user moved on: this result belongs to another dimension and
            // cannot settle the one on screen. The list is cached under this
            // region's key, so a return to it settles from the cache instead
            // of re-asking.
            prefetchedRef.current.delete(key);
            return;
          }
          settleProbe(fetchable.id, { status: "resolved" });
        }
        // The card shows what was found, so the newest build gets its label:
        // the shared cache folds in first (free), then one lookup for that
        // version only — `force` keeps the card honest with the switch off.
        void fillVersionsSilently(probeAccount, target, versions.slice(0, 1), {
          force: true,
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || !verify) return;
        const view = viewRef.current;
        if (view.country !== probeRegion || view.platform !== probePlatform) {
          prefetchedRef.current.delete(key);
          return;
        }
        if (appPresenceFromProbeError(error) === "missing") {
          // Nothing to fetch for this id at all — but only a bare record is
          // nothing *but* the id. A package-index record is proof the app
          // exists, so Apple's answer settles this platform at most: the
          // record stays and says it could not be settled.
          if (bare) {
            dropResult(fetchable.id);
            return;
          }
        }
        settleProbe(fetchable.id, {
          status: "unresolved",
          note: getErrorMessage(error, t("search.versions.loadFailed")),
        });
      });
  }, [
    results,
    probes,
    activePlatform,
    activeCountry,
    accounts,
    listVersionsWithLicense,
    dropResult,
    fillVersionsSilently,
    t,
  ]);

  const availableCountryCodes = Array.from(
    new Set(
      accounts
        .map((a) => storeIdToCountry(a.store))
        .filter(Boolean) as string[],
    ),
  ).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const allCountryCodes = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    search(term.trim(), activeCountry, activePlatform);
  }

  return (
    <PageContainer title={t("search.title")}>
      <form
        onSubmit={handleSubmit}
        className="mb-8 space-y-3 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-4"
      >
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_170px_auto] sm:items-start">
          <div className="min-w-0">
            <label
              htmlFor="search-term"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t("search.label")}
            </label>
            <input
              id="search-term"
              type="text"
              value={term}
              onChange={(e) => setSearchParam({ term: e.target.value })}
              placeholder={t("search.placeholder")}
              className="min-h-11 w-full rounded-2xl border-0 bg-gray-100 px-4 py-2.5 text-base text-gray-900 placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-400"
            />
          </div>
          <div className="min-w-0">
            <label
              htmlFor="search-version-id"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t("downloads.add.versionId")}
            </label>
            <input
              id="search-version-id"
              type="text"
              inputMode="numeric"
              value={versionId}
              onChange={(e) => {
                setVersionId(e.target.value);
                versionIdRef.current = e.target.value;
              }}
              placeholder={t("downloads.add.versionIdPlaceholder")}
              className="min-h-11 w-full rounded-2xl border-0 bg-gray-100 px-4 py-2.5 text-base text-gray-900 placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-400"
            />
            {versionId.trim() !== "" && !versionIdValid && (
              <p className="mt-1 min-w-0 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
                {t("downloads.add.invalidVersionId")}
              </p>
            )}
          </div>
          <div className="min-w-0">
            <label className="mb-1 hidden text-sm font-medium sm:block sm:invisible">
              {t("search.button")}
            </label>
            <button
              type="submit"
              disabled={loading || !term.trim()}
              className="min-h-11 w-full whitespace-nowrap rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              <StableLabel
                idle={t("search.button")}
                busy={t("search.searching")}
                busyActive={loading}
              />
            </button>
          </div>
        </div>
        <div className="flex w-full gap-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <PlatformSelect
            value={activePlatform}
            onChange={(p) => {
              setSearchParam({ platform: p });
              // Flipping the platform re-runs the search straight away — but
              // only a search that actually happened. A term typed without
              // pressing 搜索 is not a query yet, so switching dimensions must
              // not fire one for it.
              if (searched && term.trim()) search(term.trim(), activeCountry, p);
            }}
            wrapperClassName="w-1/2"
            className="min-h-11 w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white"
          />
          <CountrySelect
            value={activeCountry}
            onChange={(c) => {
              setSearchParam({ country: c });
              if (searched && term.trim()) search(term.trim(), c, activePlatform);
            }}
            availableCountryCodes={availableCountryCodes}
            allCountryCodes={allCountryCodes}
            wrapperClassName="w-1/2"
            className="truncate border-0 bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white"
          />
        </div>
      </form>

      {results.length === 0 && !loading && !error && !searched && (
        <div className="flex flex-col items-center justify-center rounded-3xl bg-white px-6 py-16 text-center shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-950">
            <svg
              className="h-8 w-8 text-blue-600 dark:text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
            {t("search.empty")}
          </h3>
          <p className="max-w-full whitespace-nowrap text-[clamp(0.5625rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-500 dark:text-gray-400">
            {t("search.emptyDesc")}
          </p>
        </div>
      )}

      {results.length === 0 && !loading && !error && searched && (
        <div className="flex flex-col items-center justify-center rounded-3xl bg-white px-6 py-16 text-center shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 dark:bg-gray-800">
            <svg
              className="h-8 w-8 text-gray-400 dark:text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
            {t("search.noResults")}
          </h3>
          <p className="max-w-full text-[clamp(0.5625rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-500 dark:text-gray-400">
            {t("search.noResultsDesc")}
          </p>
        </div>
      )}

      {results.length > 0 && (
        <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {results.map((app) => {
              // A record with no evidence for this platform is only walkable
              // once the version exchange has produced versions for it: without
              // them the detail view has nothing to show, and while the
              // exchange runs it is still an open question. Every other record
              // came with metadata for the platform on screen.
              const verifying = needsFetchVerification(app);
              const bare = app.metadataSource === "bare";
              const probe = verifying ? probes[app.id] : undefined;
              const open = probe === undefined || probe.status === "resolved";
              const subtitle =
                probe?.status === "checking"
                  ? t(bare ? "search.bareChecking" : "search.localChecking")
                  : probe?.status === "unresolved"
                    ? t(bare ? "search.bareUnverified" : "search.localUnverified", {
                        reason: probe.note,
                      })
                    : app.artistName;
              // What is known about the version: the newest build the exchange
              // produced for this app+platform, else the record's own version
              // (a store result's, or the build a past download recorded).
              const newestVersionId =
                versionLists[
                  versionListKey(app.id, activePlatform, activeCountry)
                ]?.[0] ?? "";
              const version =
                (newestVersionId && versionMeta[newestVersionId]?.displayVersion) ||
                app.version ||
                "";
              // Only fields we actually have are rendered: an empty span still
              // takes a flex gap, which would push the next one out of line
              // with the title above it. That includes the price — a delisted
              // or bare record has none, and neither a dash nor a "free" it was
              // never told would be honest.
              const price = displayPrice(app, t("search.free"));
              const meta: { text: string; truncate?: boolean }[] = [
                ...(price ? [{ text: price }] : []),
                ...(app.primaryGenreName
                  ? [{ text: app.primaryGenreName, truncate: true }]
                  : []),
                ...(version ? [{ text: version }] : []),
                ...(app.averageUserRating > 0
                  ? [{ text: `★ ${app.averageUserRating.toFixed(1)}` }]
                  : []),
              ];
              const body = (
                <>
                  <AppIcon url={app.artworkUrl} name={app.name} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-gray-900 dark:text-white">
                      {app.name}
                      {app.metadataSource === "local" && (
                        <span className="ml-2 inline-block rounded-full bg-orange-50 px-2 py-0.5 align-middle text-xs font-medium text-orange-600 dark:bg-orange-950/60 dark:text-orange-400">
                          {t("downloads.add.localRecordTag")}
                        </span>
                      )}
                      {app.metadataSource === "bare" && (
                        <span className="ml-2 inline-block rounded-full bg-orange-50 px-2 py-0.5 align-middle text-xs font-medium text-orange-600 dark:bg-orange-950/60 dark:text-orange-400">
                          {t("search.bareRecordTag")}
                        </span>
                      )}
                    </p>
                    {subtitle !== "" && (
                      <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                        {subtitle}
                      </p>
                    )}
                    {meta.length > 0 && (
                      <div className="mt-1 flex items-center gap-2 overflow-hidden text-xs text-gray-400 dark:text-gray-500">
                        {meta.map((item) => (
                          <span
                            key={item.text}
                            className={item.truncate ? "truncate" : "shrink-0"}
                          >
                            {item.text}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {open && (
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xl text-blue-600 dark:bg-gray-800 dark:text-blue-400"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  )}
                </>
              );

              if (!open) {
                return (
                  <div key={app.id} className="flex items-center gap-4 p-4">
                    {body}
                  </div>
                );
              }

              return (
                <Link
                  key={app.id}
                  to={`/search/${app.id}?platform=${activePlatform}`}
                  state={{
                    app,
                    country: activeCountry,
                    versionId:
                      versionIdValid && versionId.trim()
                        ? versionId.trim()
                        : undefined,
                  }}
                  className="flex items-center gap-4 p-4 transition-colors hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-gray-800/70 dark:active:bg-gray-800"
                >
                  {body}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
