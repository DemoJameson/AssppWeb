import { useState, useEffect, useRef } from "react";
import { useParams, useLocation, useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Alert from '../common/Alert';
import AppIcon from "../common/AppIcon";
import PlatformSelect from '../common/PlatformSelect';
import Select from '../common/Select';
import Spinner from '../common/Spinner';
import {
  isProductPreviewEnabled,
  previewProductAccounts,
  previewProductApp,
} from './productPreview';
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSelectedAccount } from "../../hooks/useSelectedAccount";
import { useVersionMetadataMap } from "../../hooks/useVersionMetadata";
import { useToastStore } from '../../store/toast';
import { lookupAppById } from "../../api/search";
import { useSettingsStore } from "../../store/settings";
import {
  ensureVersionList,
  getCachedVersionList,
  rememberVersionList,
  useVersionListsStore,
  versionListKey,
} from "../../store/versionLists";
import { getErrorMessage } from "../../utils/error";
import {
  bareSoftwareById,
  displayPrice,
  formatDateISO,
  needsFetchVerification,
  needsVersionExchange,
} from "../../utils/software";
import { appPresenceFromProbeError } from "../../apple/errors";
import { versionOptionLabel } from "../../utils/versionLabels";
import { parsePlatform, PLATFORM_LABELS } from "../../apple/platform";
import { accountSelectLabel, accountStoreCountry } from "../../utils/account";
import { formatBytes } from "../../utils/format";
import type { Platform, Software } from "../../types";

export default function ProductDetail() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { accounts } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((state) => state.addToast);
  const {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
    listVersionsWithLicense,
  } = useDownloadAction();

  const previewEnabled = isProductPreviewEnabled(location.search);
  const productAccounts = previewEnabled ? previewProductAccounts : accounts;
  const routeState = location.state as {
    app?: Software;
    country?: string;
    versionId?: string;
  } | null;
  const stateApp = previewEnabled ? previewProductApp : routeState?.app;
  const stateCountry = previewEnabled ? 'US' : routeState?.country;
  const routeVersionId =
    !previewEnabled &&
    typeof routeState?.versionId === 'string' &&
    /^\d+$/.test(routeState.versionId)
      ? routeState.versionId
      : '';
  const [searchParams] = useSearchParams();
  // The app in the router state carries its platform; a direct visit falls
  // back to the query the search results attached. The selector below can
  // change it afterwards.
  const [platform, setPlatform] = useState<Platform>(
    stateApp?.platform ?? parsePlatform(searchParams.get("platform")) ?? "ios",
  );
  const [country, setCountry] = useState(stateCountry ?? "US");
  const [app, setApp] = useState<Software | null>(stateApp ?? null);
  const [loading, setLoading] = useState(!stateApp);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadingAction, setLoadingAction] = useState<
    "purchase" | "download" | "versions" | null
  >(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [checkingVersions, setCheckingVersions] = useState(false);
  const autoFetchVersionInfo = useSettingsStore((s) => s.autoFetchVersionInfo);
  const {
    versionMeta,
    pendingMeta,
    prefetchMissing,
    fillVersionsSilently,
  } = useVersionMetadataMap();

  const { selectedAccount, selectAccount } = useSelectedAccount(productAccounts);

  const account = productAccounts.find((a) => a.email === selectedAccount);
  const isDownloading = loadingAction === 'download';
  const isPurchasing = loadingAction === 'purchase';
  const isSelectingVersions = loadingAction === 'versions';

  // The version-list cache is keyed by app+platform+region: a different
  // storefront answers differently, so its lists must never be reused here.
  // The region is this page's own dimension (it follows the selected account's
  // storefront), and the search page's prefetch wrote under the same region it
  // navigated in with.

  // The newest version the fetched list knows — it beats the recorded build,
  // which can be a stale download (a delisted app shows its true latest).
  const cachedVersions = useVersionListsStore((s) =>
    app ? s.lists[versionListKey(app.id, app.platform, country)] : undefined,
  );
  const latestListVersionId = cachedVersions?.[0] ?? "";
  const displayVersion =
    (latestListVersionId && versionMeta[latestListVersionId]?.displayVersion) ||
    app?.version ||
    "";

  // The external id printed next to the display version: the build the list
  // named when the label came from the exchange, else the one the record or
  // package carried.
  const displayVersionId =
    latestListVersionId &&
    versionMeta[latestListVersionId]?.displayVersion === displayVersion
      ? latestListVersionId
      : (app?.externalVersionId || "");

  // Undefined when nobody priced this app — a delisted or bare record then gets
  // no chip at all rather than a dash standing in for data.
  const price = app ? displayPrice(app, t("search.product.free")) : undefined;

  // The accounts that can serve this page's region, and the ones that cannot.
  // A foreign account cannot answer this region's storefront calls, so it is
  // never shown as the current pick — the control says there is no account
  // instead, and offers the others as a deliberate move in their own group.
  const regionAccounts = productAccounts.filter(
    (a) => accountStoreCountry(a) === country,
  );
  const otherRegionAccounts = productAccounts.filter(
    (a) => accountStoreCountry(a) !== country,
  );
  const selectedIsRegionAccount = regionAccounts.some(
    (a) => a.email === selectedAccount,
  );

  // The picked region needs an account: without one the actions are hidden
  // and a notice asks for another region's account (the selector above).
  const noRegionAccount =
    !previewEnabled &&
    productAccounts.length > 0 &&
    regionAccounts.length === 0;

  /** Set when the user explicitly moved to an account's storefront. */
  const explicitMoveRef = useRef<string | null>(null);

  /**
   * Reloads the app for the current storefront and platform. The navigation
   * state is used as-is on first render; afterwards any account pick (which
   * moves `country` to that account's storefront) or platform change
   * refetches, so the page always reflects the selection — and a selection
   * the app does not exist in snaps back to the previous one with a notice
   * instead of dead-ending on the not-found page.
   */
  const lastLookupKeyRef = useRef<string | null>(
    stateApp ? `${appId}|${stateCountry ?? "US"}|${platform}|0` : null,
  );

  // The last selection that actually resolved; the snap-back target. Only the
  // newest lookup may apply — switches can be fired faster than they settle.
  const lastGoodRef = useRef<{
    country: string;
    platform: Platform;
    email?: string;
  } | null>(
    stateApp
      ? { country: stateCountry ?? "US", platform, email: undefined }
      : null,
  );
  const lookupSeqRef = useRef(0);

  useEffect(() => {
    if (!appId) return;
    const lookupKey = `${appId}|${country}|${platform}|${reloadToken}`;
    if (lookupKey === lastLookupKeyRef.current) return;
    lastLookupKeyRef.current = lookupKey;

    // The loaded version list belongs to the previous storefront/platform.
    setVersions([]);
    setSelectedVersion("");
    setVersionsOpen(false);

    setLoading(true);
    const seq = ++lookupSeqRef.current;
    lookupAppById(appId, country, platform)
      .then((result) => {
        if (seq !== lookupSeqRef.current) return;
        if (result) {
          lastGoodRef.current = { country, platform, email: selectedAccount };
          setApp(result);
          setLoading(false);
          return;
        }
        const lastGood = lastGoodRef.current;
        // The notice button is a second, deliberate confirmation to leave the
        // region: a miss there is the truth to show, not a mistake to undo —
        // with a single account the snap-back would be an inescapable loop.
        // A plain dropdown pick keeps the old protection.
        const forcedMove = explicitMoveRef.current === country;
        explicitMoveRef.current = null;
        if (
          previewEnabled ||
          forcedMove ||
          !lastGood ||
          (lastGood.country === country && lastGood.platform === platform)
        ) {
          // Nothing carries the app here, and there is no earlier selection to
          // fall back to. A numeric App ID may still be real even so — the
          // version exchange decides that (see the probe below) — so the record
          // is kept and probed rather than declared missing on the spot.
          const bare = /^\d+$/.test(appId)
            ? bareSoftwareById(appId, platform)
            : null;
          if (bare) {
            lastGoodRef.current = { country, platform, email: selectedAccount };
          }
          setApp(bare);
          setLoading(false);
          return;
        }
        // The app is not carried here (region or platform) — say so and snap
        // back to the last selection that resolved; that restarts this effect.
        addToast(
          lastGood.country !== country
            ? t("search.product.regionUnavailable")
            : t("search.product.platformUnavailable"),
          "info",
        );
        if (lastGood.country !== country) {
          setCountry(lastGood.country);
          const match =
            productAccounts.find((a) => a.email === lastGood.email) ??
            productAccounts.find(
              (a) => accountStoreCountry(a) === lastGood.country,
            );
          if (match) selectAccount(match.email);
        }
        if (lastGood.platform !== platform) setPlatform(lastGood.platform);
      })
      .catch(() => {
        if (seq !== lookupSeqRef.current) return;
        setLoading(false);
      });
  }, [
    appId,
    stateApp,
    country,
    platform,
    reloadToken,
    previewEnabled,
    productAccounts,
    selectedAccount,
    selectAccount,
    addToast,
    t,
  ]);

  // A record the storefront does not carry — a delisted app, or a bare App ID
  // nothing knows — gets its version list fetched in the background when the
  // view opens, bounded and silent, so 选择版本 can open straight from the cache
  // instead of waiting on the exchange. A cached list still gets its labels
  // filled (newest-version display / picker text).
  //
  // For a record with no evidence for the platform on screen this exchange is
  // also the only thing that can say whether anything is fetchable here: Apple
  // reporting nothing to serve means there is nothing to fetch, so a bare id
  // falls through to not-found rather than offering a download that can never
  // be built. A `local` record is evidence from a compiled package — of *some*
  // platform — so Apple's answer settles this platform at most: it stays, with
  // the notice saying why it could not be settled. A failure about the session
  // or the transport concludes nothing either way.
  const prefetchedListKeysRef = useRef<Set<string>>(new Set());
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
  const [probeNote, setProbeNote] = useState("");
  useEffect(() => {
    if (!app || previewEnabled) return;
    if (!needsVersionExchange(app)) return;
    const verify = needsFetchVerification(app);
    const bare = app.metadataSource === "bare";
    const key = versionListKey(app.id, app.platform, country);
    const cached = getCachedVersionList(key);
    if (cached) {
      // The exchange already answered for this id and produced versions: they
      // are the proof something is fetchable here, so nothing is unverified.
      setProbeNote("");
      if (account) fillVersionsSilently(account, app, cached);
      return;
    }
    if (!account) {
      // Only a page that really has no account says so — the selector settles
      // one render later, and that must not read as "unverifiable".
      if (verify && productAccounts.length === 0) {
        setProbeNote(t("search.bareNoAccount"));
      }
      return;
    }
    if (prefetchedListKeysRef.current.has(key)) return;
    prefetchedListKeysRef.current.add(key);
    void ensureVersionList(key, () =>
      listVersionsWithLicense(account, app, routeVersionId || undefined),
    )
      .then((versions) => {
        // The exchange cannot be called off, but a page that is gone gets
        // neither its note nor its fill.
        if (!mountedRef.current) return;
        setProbeNote("");
        fillVersionsSilently(account, app, versions);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || !verify) return;
        if (bare && appPresenceFromProbeError(error) === "missing") {
          setApp(null);
          return;
        }
        setProbeNote(getErrorMessage(error, t("search.versions.loadFailed")));
      });
  }, [
    app,
    account,
    productAccounts,
    previewEnabled,
    routeVersionId,
    listVersionsWithLicense,
    fillVersionsSilently,
    t,
  ]);

  // Entering from a search that picked a region brings the matching account
  // along, so the view speaks for that storefront from the start — and it
  // keeps re-asserting until the selection is settled, so a React StrictMode
  // double-run of the neighbour effect cannot clobber it. Once settled, the
  // picker is left alone.
  const regionHonoredRef = useRef(false);
  useEffect(() => {
    if (regionHonoredRef.current || previewEnabled || !stateCountry) return;
    if (productAccounts.length === 0) return;
    const matching = productAccounts.filter(
      (a) => accountStoreCountry(a) === stateCountry,
    );
    if (matching.some((a) => a.email === selectedAccount)) {
      regionHonoredRef.current = true;
      return;
    }
    if (matching.length === 0) {
      regionHonoredRef.current = true;
      return;
    }
    selectAccount(matching[0].email);
  }, [
    stateCountry,
    productAccounts,
    selectedAccount,
    selectAccount,
    previewEnabled,
  ]);

  if (loading) {
    return (
      <PageContainer title={t("search.product.title")}>
        <div className="text-center text-gray-500 py-12">{t("loading")}</div>
      </PageContainer>
    );
  }

  if (!app) {
    return (
      <PageContainer title={t("search.product.title")}>
        <p className="text-gray-500">{t("search.product.notFound")}</p>
      </PageContainer>
    );
  }

  /**
   * Picking an account moves the view to that account's storefront: the
   * country follows the account, and the reload token forces a refetch even
   * when the storefront did not change.
   */
  function handleAccountChange(email: string, forced = false) {
    selectAccount(email);
    const next = productAccounts.find((a) => a.email === email);
    const nextCountry = accountStoreCountry(next);
    // An explicit move insists: a lookup miss on that storefront stands
    // instead of snapping back. The picker asks for one when the region has
    // no account — leaving it is the only way forward.
    explicitMoveRef.current = forced ? (nextCountry ?? null) : null;
    if (nextCountry) setCountry(nextCountry);
    setReloadToken((token) => token + 1);
  }

  /**
   * Picks an account from the list. A region with no account leaves the picker
   * as the only way out, so a pick made there counts as the deliberate move it
   * looks like — a miss on the new storefront stands rather than snapping back
   * to the region just left.
   */
  function handleAccountPick(email: string) {
    handleAccountChange(email, noRegionAccount);
  }

  async function handlePurchase() {
    if (!account || !app) return;
    setLoadingAction("purchase");
    try {
      if (previewEnabled) {
        await waitForPreviewAction();
        addToast(
          t('search.product.previewActionComplete'),
          'success',
          t('search.product.previewBadge'),
        );
        return;
      }
      await acquireLicense(account, app);
    } catch (e) {
      toastLicenseError(account, app, e);
    } finally {
      setLoadingAction(null);
    }
  }

  function applyVersionList(list: string[]) {
    setVersions(list);
    // Versions arrived, so the id is answered — nothing is unverified now.
    setProbeNote("");
    // A route-supplied version id stays the selection when the list carries
    // it; otherwise the newest build is the default.
    setSelectedVersion(
      routeVersionId && list.includes(routeVersionId)
        ? routeVersionId
        : list[0] || "",
    );
    setVersionsOpen(true);
    if (account && app) {
      // Shared cache first, then the missing labels filled silently — the
      // policy the old new-download page opened its picker with.
      fillVersionsSilently(account, app, list);
    }
  }

  /** Opens the version picker — from the cache when the list is known. */
  async function handleSelectVersions() {
    if (!app) return;
    if (previewEnabled) {
      await waitForPreviewAction();
      addToast(
        t('search.product.previewActionComplete'),
        'success',
        t('search.product.previewBadge'),
      );
      return;
    }
    const cached = getCachedVersionList(
      versionListKey(app.id, app.platform, country),
    );
    if (cached) {
      applyVersionList(cached);
      return;
    }
    if (!account) return;
    setLoadingAction("versions");
    try {
      const result = await listVersionsWithLicense(
        account,
        app,
        routeVersionId || undefined,
      );
      rememberVersionList(
        versionListKey(app.id, app.platform, country),
        result.versions,
      );
      applyVersionList(result.versions);
    } catch (e) {
      addToast(getErrorMessage(e, t("search.versions.loadFailed")), "error");
    } finally {
      setLoadingAction(null);
    }
  }

  /**
   * The manual counterpart of the silent fill, offered when the automation
   * switch is off: look the missing version numbers up on demand.
   */
  async function handleCheckVersions() {
    if (!account || !app || versions.length === 0) return;
    setCheckingVersions(true);
    try {
      await prefetchMissing(account, app, versions, { force: true });
    } finally {
      setCheckingVersions(false);
    }
  }

  async function handleDownload() {
    if (!account || !app) return;
    setLoadingAction("download");
    try {
      if (previewEnabled) {
        await waitForPreviewAction();
        addToast(
          t('search.product.previewActionComplete'),
          'success',
          t('search.product.previewBadge'),
        );
        return;
      }
      await startDownload(
        account,
        app,
        selectedVersion || routeVersionId || latestListVersionId || undefined,
        country,
      );
    } catch (e) {
      toastDownloadError(account, app, e);
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <PageContainer>
      <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
        {previewEnabled && (
          <Alert type="warning">
            <span className="font-semibold">
              {t('search.product.previewBadge')}
            </span>{' '}
            {t('search.product.previewDescription')}
          </Alert>
        )}

        <section className="flex min-w-0 items-start gap-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:gap-5 sm:p-6">
          <div className="shrink-0">
            <AppIcon url={app.artworkUrl} name={app.name} size="lg" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-3xl">
              {app.name}
              {app.metadataSource === "bare" && (
                <span className="ml-2 inline-block rounded-full bg-orange-50 px-2 py-0.5 align-middle text-xs font-medium text-orange-600 dark:bg-orange-950/60 dark:text-orange-400">
                  {t("search.bareRecordTag")}
                </span>
              )}
            </h1>
            <p className="text-gray-500 dark:text-gray-400">{app.artistName}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
              {app.platform && (
                <span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
                  {PLATFORM_LABELS[app.platform]}
                </span>
              )}
              {price && (
                <span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
                  {price}
                </span>
              )}
              {app.primaryGenreName && (
                <span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
                  {app.primaryGenreName}
                </span>
              )}
              {displayVersion && (
                <span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
                  {displayVersion}
                </span>
              )}
              {app.averageUserRating > 0 && (
                <span className="inline-flex items-center">
                  ★ {app.averageUserRating.toFixed(1)} ({app.userRatingCount}{" "}
                  {t("search.product.ratings")})
                </span>
              )}
            </div>
            {app.metadataSource === "local" && (
              <p className="mt-3 min-w-0 break-words rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                {t("downloads.add.localRecordNote")}
              </p>
            )}
            {app.metadataSource === "bare" && (
              <p className="mt-3 min-w-0 break-words rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                {t("search.bareRecordNote")}
              </p>
            )}
            {/* Only when nothing is known: a version on screen is proof the
                exchange produced something for this platform. */}
            {needsFetchVerification(app) && probeNote && !displayVersion && (
              <p className="mt-3 min-w-0 break-words rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {t(
                  app.metadataSource === "bare"
                    ? "search.bareUnverified"
                    : "search.localUnverified",
                  { reason: probeNote },
                )}
              </p>
            )}
          </div>
        </section>

        {productAccounts.length === 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-yellow-50 px-4 py-3 text-xs text-yellow-800 ring-1 ring-yellow-200/70 dark:bg-yellow-950/30 dark:text-yellow-300 dark:ring-yellow-800/50">
            <Link
              to="/accounts/add"
              className="shrink-0 rounded-full bg-yellow-100 px-3 py-1.5 font-semibold text-yellow-800 transition-colors hover:bg-yellow-200 dark:bg-yellow-900/60 dark:text-yellow-200 dark:hover:bg-yellow-900"
            >
              {t("search.product.addAccountLink")}
            </Link>
            <span>{t("search.product.addAccountPrompt")}</span>
          </div>
        ) : (
          <section className="space-y-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
              <PlatformSelect
                value={platform}
                onChange={setPlatform}
                disabled={loadingAction !== null}
                className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
              />
              <Select
                value={selectedIsRegionAccount ? selectedAccount : ""}
                onChange={handleAccountPick}
                placeholder={
                  noRegionAccount
                    ? t("search.product.accountNoneInRegion")
                    : undefined
                }
                options={[
                  ...regionAccounts.map((a) => ({
                    value: a.email,
                    label: accountSelectLabel(a, t),
                    group: t("search.product.account"),
                  })),
                  ...otherRegionAccounts.map((a) => ({
                    value: a.email,
                    label: accountSelectLabel(a, t),
                    group: t("search.product.account"),
                  })),
                ]}
                ariaLabel={t("search.product.account")}
                disabled={loadingAction !== null}
                className="min-h-11 w-full min-w-0 rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
              />
            </div>
            {!noRegionAccount && versionsOpen && versions.length > 0 && (
              <div className="min-w-0">
                <Select
                  value={selectedVersion}
                  onChange={setSelectedVersion}
                  options={versions.map((v) => ({
                    value: v,
                    label: versionOptionLabel(v, versionMeta[v], pendingMeta[v]),
                    group: t("search.product.version"),
                  }))}
                  ariaLabel={t("search.product.version")}
                  className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white"
                />
              </div>
            )}
            {noRegionAccount ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-yellow-50 px-4 py-3 text-xs text-yellow-800 ring-1 ring-yellow-200/70 dark:bg-yellow-950/30 dark:text-yellow-300 dark:ring-yellow-800/50">
                <span>
                  {t("search.product.noRegionAccount", {
                    country: t(`countries.${country}`, country),
                  })}
                </span>
              </div>
            ) : (
              <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
              {(app.price === undefined || app.price === 0) &&
                app.metadataSource !== "local" &&
                app.metadataSource !== "bare" && (
                <button
                  type="button"
                  onClick={handlePurchase}
                  disabled={loadingAction !== null}
                  aria-busy={isPurchasing}
                  className="inline-flex min-h-10 w-full min-w-0 items-center justify-center gap-1.5 rounded-full bg-blue-100 px-2 py-2 text-center text-xs font-semibold leading-tight text-blue-700 transition-colors hover:bg-blue-200 active:bg-blue-200 disabled:opacity-50 dark:bg-blue-950/60 dark:text-blue-400 sm:gap-2 sm:px-5 sm:text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-4 w-4 shrink-0 items-center justify-center"
                  >
                    {isPurchasing ? <Spinner /> : <LicenseIcon />}
                  </span>
                  <span>{t("search.product.getLicense")}</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleDownload}
                disabled={loadingAction !== null || !account}
                aria-busy={isDownloading}
                className={`inline-flex min-h-10 w-full min-w-0 items-center justify-center gap-1.5 rounded-full bg-blue-600 px-2 py-2 text-center text-xs font-semibold leading-tight text-white transition-colors hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed sm:gap-2 sm:px-5 sm:text-sm ${
                  !account || (loadingAction !== null && !isDownloading)
                    ? 'opacity-50'
                    : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 shrink-0 items-center justify-center"
                >
                  {isDownloading ? <Spinner /> : <DownloadIcon />}
                </span>
                <span>{t("search.product.download")}</span>
              </button>
              {!versionsOpen && (
                <button
                  type="button"
                  onClick={handleSelectVersions}
                  disabled={loadingAction !== null || !account}
                  aria-busy={isSelectingVersions}
                  className="inline-flex min-h-10 w-full min-w-0 items-center justify-center gap-1.5 rounded-full bg-orange-100 px-2 py-2 text-center text-xs text-orange-700 transition-colors hover:bg-orange-200 active:bg-orange-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-orange-950/60 dark:text-orange-400 sm:gap-2 sm:px-5 sm:text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-4 w-4 shrink-0 items-center justify-center"
                  >
                    {isSelectingVersions ? <Spinner /> : <VersionsIcon />}
                  </span>
                  <span>{t("search.product.selectVersion")}</span>
                </button>
              )}
              {versionsOpen &&
                versions.length > 0 &&
                !autoFetchVersionInfo && (
                  <button
                    type="button"
                    onClick={handleCheckVersions}
                    disabled={
                      loadingAction !== null || !account || checkingVersions
                    }
                    aria-busy={checkingVersions}
                    className="inline-flex min-h-10 w-full min-w-0 items-center justify-center gap-1.5 rounded-full bg-orange-100 px-2 py-2 text-center text-xs text-orange-700 transition-colors hover:bg-orange-200 active:bg-orange-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-orange-950/60 dark:text-orange-400 sm:gap-2 sm:px-5 sm:text-sm"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-4 w-4 shrink-0 items-center justify-center"
                    >
                      {checkingVersions ? <Spinner /> : <LookupIcon />}
                    </span>
                    <span>{t("search.product.checkVersionNumbers")}</span>
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-2">
            {t("search.product.details")}
          </h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.appId")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200 break-all">
              {app.id}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.bundleId")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200 break-all">
              {app.bundleID || "—"}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.version")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200">
              {displayVersion
                ? `${displayVersion}${displayVersionId ? ` (${displayVersionId})` : ""}`
                : "—"}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.size")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200">
              {app.fileSizeBytes ? formatBytes(app.fileSizeBytes) : "—"}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.minOs")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200">
              {app.minimumOsVersion
                ? `${PLATFORM_LABELS[app.platform || 'ios']} ${app.minimumOsVersion}`
                : "—"}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.seller")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200">
              {app.sellerName || "—"}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">
              {t("search.product.released")}
            </dt>
            <dd className="text-gray-900 dark:text-gray-200">
              {formatDateISO(app.releaseDate) ?? "—"}
            </dd>
          </dl>
        </section>

        {app.description && (
          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">
              {t("search.product.description")}
            </h2>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">
              {app.description}
            </p>
          </section>
        )}

        {app.releaseNotes && (
          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">
              {t("search.product.releaseNotes")}
            </h2>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">
              {app.releaseNotes}
            </p>
          </section>
        )}

        {app.screenshotUrls && app.screenshotUrls.length > 0 && (
          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">
              {t("search.product.screenshots")}
            </h2>
            <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {app.screenshotUrls.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt={`Screenshot ${i + 1}`}
                  className="h-64 shrink-0 snap-start snap-always rounded-3xl object-contain sm:h-80"
                  loading="lazy"
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </PageContainer>
  );
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"
      />
    </svg>
  );
}

/** The entitlement behind this account's download: a key. */
function LicenseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
      />
    </svg>
  );
}

/** The build list this picker opens: stacked layers. */
function VersionsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
      />
    </svg>
  );
}

/** Looking a version number up: a magnifier. */
function LookupIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35"
      />
    </svg>
  );
}

function waitForPreviewAction(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 2000);
  });
}
