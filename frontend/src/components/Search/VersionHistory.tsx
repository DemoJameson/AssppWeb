import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import PlatformSelect from "../common/PlatformSelect";
import Select from "../common/Select";
import StableLabel from "../common/StableLabel";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSelectedAccount } from "../../hooks/useSelectedAccount";
import { useVersionMetadataMap } from "../../hooks/useVersionMetadata";
import { storeIdToCountry } from "../../apple/config";
import { getVersionMetadata } from "../../apple/versionLookup";
import { lookupAppById } from "../../api/search";
import { parsePlatform } from "../../apple/platform";
import { getErrorMessage } from "../../utils/error";
import { versionRowLabel } from "../../utils/versionLabels";
import { accountSelectLabel } from "../../utils/account";
import { useToastStore } from "../../store/toast";
import type { Software, Platform } from "../../types";

export default function VersionHistory() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { accounts, updateAccount } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const { startDownload, toastDownloadError, listVersionsWithLicense } =
    useDownloadAction();

  const routeState = location.state as {
    app?: Software;
    country?: string;
    account?: string;
    platform?: Platform;
  } | null;
  const stateApp = routeState?.app;
  const stateCountry = routeState?.country;
  const stateAccount = routeState?.account;
  const country = stateCountry ?? "US";
  const [searchParams] = useSearchParams();
  // This page only reflects the choices made on the previous page.
  const platform: Platform =
    routeState?.platform ??
    stateApp?.platform ??
    parsePlatform(searchParams.get("platform")) ??
    "ios";

  const [app, setApp] = useState<Software | null>(stateApp ?? null);
  const [loadingApp, setLoadingApp] = useState(!stateApp);

  const filteredAccounts = useMemo(
    () => accounts.filter((a) => storeIdToCountry(a.store) === country),
    [accounts, country],
  );
  const { selectedAccount } = useSelectedAccount(filteredAccounts);
  const [versions, setVersions] = useState<string[]>([]);
  const { versionMeta, ensureLoaded, recordMetadata, prefetchMissing } =
    useVersionMetadataMap();
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState<Record<string, boolean>>({});
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!stateApp && appId) {
      setLoadingApp(true);
      lookupAppById(appId, country, platform)
        .then((result) => {
          setApp(result);
          setLoadingApp(false);
        })
        .catch(() => {
          setLoadingApp(false);
        });
    }
  }, [appId, stateApp, country, platform]);

  // The account comes in from the previous page; fall back to the usual pick
  // when the page is opened directly.
  const account =
    (stateAccount
      ? accounts.find((a) => a.email === stateAccount)
      : undefined) ?? accounts.find((a) => a.email === selectedAccount);

  async function handleLoadVersions() {
    if (!account || !app) return;
    setLoading(true);
    try {
      const result = await listVersionsWithLicense(account, app);
      setVersions(result.versions);
      await ensureLoaded(app.id);
      // Fill the missing labels silently in the background.
      prefetchMissing(account, app, result.versions);
    } catch (e) {
      addToast(getErrorMessage(e, t("search.versions.loadFailed")), "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadMeta(versionId: string) {
    if (!account || !app || versionMeta[versionId]) return;
    setLoadingMeta((prev) => ({ ...prev, [versionId]: true }));
    try {
      const result = await getVersionMetadata(account, app, versionId);
      recordMetadata(app.id, versionId, result.metadata);
      await updateAccount({ ...account, cookies: result.updatedCookies });
    } catch {
      // Silently fail for individual version metadata
    } finally {
      setLoadingMeta((prev) => ({ ...prev, [versionId]: false }));
    }
  }

  async function handleDownloadVersion(versionId: string) {
    if (!account || !app) return;
    setDownloadingVersion(versionId);
    try {
      await startDownload(account, app, versionId);
    } catch (e) {
      toastDownloadError(account, app, e);
    } finally {
      setDownloadingVersion(null);
    }
  }

  if (loadingApp) {
    return (
      <PageContainer title={t("search.versions.title")}>
        <div className="text-center text-gray-500 py-12">{t("loading")}</div>
      </PageContainer>
    );
  }

  if (!app) {
    return (
      <PageContainer title={t("search.versions.title")}>
        <p className="text-gray-500 [overflow-wrap:anywhere]">
          {t("search.product.notFound")}
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t("search.versions.title")}>
      <div className="min-w-0 space-y-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="shrink-0">
            <AppIcon url={app.artworkUrl} name={app.name} size="md" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-medium text-gray-900 [overflow-wrap:anywhere] dark:text-white">
              {app.name}
            </h2>
            <p className="text-sm text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">
              {app.bundleID}
            </p>
          </div>
        </div>

        {accounts.length > 0 && !account ? (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-700 [overflow-wrap:anywhere] dark:border-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
            {t("search.product.noAccountsForRegion")}
          </div>
        ) : (
          account && (
            <div className="flex min-w-0 flex-col items-stretch gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)_auto] sm:items-end">
              <PlatformSelect
                value={platform}
                onChange={() => {}}
                disabled
                className="min-h-11 w-full min-w-0 max-w-full truncate rounded-md border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
              <Select
                value={account.email}
                onChange={() => {}}
                options={accounts.map((a) => ({
                  value: a.email,
                  label: accountSelectLabel(a, t),
                }))}
                ariaLabel={t("search.versions.account")}
                disabled
                className="min-h-11 w-full min-w-0 max-w-full truncate rounded-md border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
              <button
                onClick={handleLoadVersions}
                disabled={loading || !account}
                className="min-h-11 w-full shrink-0 whitespace-normal rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto sm:whitespace-nowrap"
              >
                <StableLabel
                  idle={t("search.versions.load")}
                  busy={t("search.versions.loading")}
                  busyActive={loading}
                />
              </button>
            </div>
          )
        )}

        {versions.length > 0 && (
          <div className="min-w-0 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
            {versions.map((versionId) => {
              const meta = versionMeta[versionId];
              const isLoadingMeta = loadingMeta[versionId];
              const isDownloading = downloadingVersion === versionId;

              return (
                <div
                  key={versionId}
                  className="flex min-w-0 items-center justify-between gap-3 p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-medium text-gray-900 [overflow-wrap:anywhere] dark:text-white">
                      {versionRowLabel(versionId, meta)}
                    </p>
                    {meta && (
                      <p className="text-sm text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">
                        {new Date(meta.releaseDate).toLocaleDateString()}
                      </p>
                    )}
                    {!meta && !isLoadingMeta && (
                      <button
                        onClick={() => handleLoadMeta(versionId)}
                        className="max-w-full py-1 text-left text-sm text-blue-600 [overflow-wrap:anywhere] transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        {t("search.versions.loadDetails")}
                      </button>
                    )}
                    {isLoadingMeta && (
                      <span className="text-sm text-gray-400 [overflow-wrap:anywhere] dark:text-gray-500">
                        {t("search.versions.loading")}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDownloadVersion(versionId)}
                    disabled={isDownloading || downloadingVersion !== null}
                    className="max-w-[45%] shrink-0 rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-medium leading-tight text-white [overflow-wrap:anywhere] transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    <StableLabel
                      idle={t("search.versions.download")}
                      busy={t("search.versions.downloading")}
                      busyActive={isDownloading}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
