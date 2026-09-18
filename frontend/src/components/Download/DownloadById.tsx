import { useState, useEffect } from "react";
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
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { lookupAppById } from "../../api/search";
import { accountSelectLabel, accountStoreCountry } from "../../utils/account";
import { getErrorMessage } from "../../utils/error";
import { versionOptionLabel } from "../../utils/versionLabels";
import type { Platform, Software } from "../../types";

/** Apple's app and version ids are both numeric. */
const NUMERIC_ID_RE = /^\d+$/;

/**
 * Stand-in for an id the catalogue did not describe. The numeric id is the only
 * thing the Apple protocol calls need, and the rest is filled in from the
 * compiled package afterwards — the backend replaces the `App <id>` label below
 * with the name the package declares (see `applyPackageMetadata` in
 * backend/src/services/downloadManager.ts), so this label only shows while the
 * download is still running.
 */
function placeholderSoftware(id: string, platform: Platform): Software {
  return {
    id: Number(id),
    bundleID: "",
    name: `App ${id}`,
    version: "",
    price: 0,
    artistName: "",
    sellerName: "",
    description: "",
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "",
    releaseDate: "",
    primaryGenreName: "",
    platform,
  };
}

/**
 * Download an app from its numeric App Store id, for when the bundle id is
 * unknown or the app cannot be found by name. Same account and region selection
 * as the regular new-download page.
 */
export default function DownloadById() {
  const { accounts } = useAccounts();
  const { defaultCountry, defaultPlatform } = useSettingsStore();
  const { t } = useTranslation();
  const { startDownload, toastDownloadError, listVersionsWithLicense } =
    useDownloadAction();
  const { versionMeta, ensureLoaded, prefetchMissing } =
    useVersionMetadataMap();
  const addToast = useToastStore((s) => s.addToast);

  const [appId, setAppId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const { selectedAccount, selectAccount } = useSelectedAccount(accounts);
  const [queued, setQueued] = useState<Software | null>(null);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const appIdValid = NUMERIC_ID_RE.test(appId.trim());
  const versionIdValid =
    versionId.trim() === "" || NUMERIC_ID_RE.test(versionId.trim());

  // A loaded version list — and a hand-entered version id — belongs to the app
  // and platform it was entered for; changing either invalidates both.
  useEffect(() => {
    setVersions([]);
    setVersionId("");
  }, [platform, appId]);

  const account = accounts.find((a) => a.email === selectedAccount);
  const country = account
    ? (accountStoreCountry(account) ?? defaultCountry)
    : defaultCountry;

  /**
   * Loads the version list for the entered app id and fills the version id
   * field with the newest one. The catalogue lookup is best effort — the
   * version exchange only needs the numeric id, so a miss must not block it
   * (same as the download flow).
   *
   * A version id already in the field pins the exchange directly: that is the
   * path that reaches a delisted app's list when the platform lookup has no
   * answer left. Empty or invalid input leaves the lookup in charge.
   */
  async function handleLoadVersions() {
    if (!account || !appIdValid || loadingVersions) return;

    const id = appId.trim();
    setLoadingVersions(true);
    try {
      const resolved = await lookupAppById(id, country, platform).catch(
        () => null,
      );
      const target = resolved
        ? { ...resolved, platform }
        : placeholderSoftware(id, platform);
      const pin =
        versionIdValid && versionId.trim() !== ""
          ? versionId.trim()
          : undefined;
      const result = await listVersionsWithLicense(account, target, pin);
      setVersions(result.versions);
      setVersionId(result.versions[0] || "");
      await ensureLoaded(target.id);
      // Fill the missing labels silently in the background.
      prefetchMissing(account, target, result.versions);
    } catch (err) {
      addToast(
        getErrorMessage(err, t("downloads.byId.versionsFailed")),
        "error",
      );
    } finally {
      setLoadingVersions(false);
    }
  }

  async function handleDownload(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !appIdValid || !versionIdValid) return;

    const id = appId.trim();
    let target = placeholderSoftware(id, platform);
    setLoading(true);
    try {
      // Best effort: the catalogue names the app and supplies its bundle id.
      // It is not required, so a miss must not block the download. The
      // catalogue's releaseDate belongs to the latest version, not the one
      // being downloaded, so clear it and let the package supply the real date.
      const resolved = await lookupAppById(id, country, platform).catch(
        () => null,
      );
      if (resolved) target = { ...resolved, platform, releaseDate: "" };
      setQueued(target);

      await startDownload(account, target, versionId.trim() || undefined);
    } catch (err) {
      toastDownloadError(account, target, err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageContainer title={t("downloads.byId.title")}>
      <div className="min-w-0 space-y-6">
        <form
          onSubmit={handleDownload}
          className="min-w-0 space-y-4 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-5"
        >
          <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-start">
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <label
                htmlFor="by-id-app-id"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("downloads.byId.appId")}
              </label>
              <input
                id="by-id-app-id"
                type="text"
                inputMode="numeric"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder={t("downloads.byId.appIdPlaceholder")}
                className="min-h-11 w-full min-w-0 rounded-xl border-0 bg-gray-100 px-4 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                disabled={loading}
              />
              {appId.trim() !== "" && !appIdValid && (
                <p className="mt-1 min-w-0 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
                  {t("downloads.byId.invalidAppId")}
                </p>
              )}
            </div>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <label
                htmlFor="by-id-version-id"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("downloads.byId.versionId")}
              </label>
              {versions.length > 0 ? (
                <Select
                  id="by-id-version-id"
                  value={versionId}
                  onChange={setVersionId}
                  options={versions.map((v) => ({
                    value: v,
                    label: versionOptionLabel(v, versionMeta[v]),
                  }))}
                  disabled={loading || loadingVersions}
                  className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                />
              ) : (
                <input
                  id="by-id-version-id"
                  type="text"
                  inputMode="numeric"
                  value={versionId}
                  onChange={(e) => setVersionId(e.target.value)}
                  placeholder={t("downloads.byId.versionIdPlaceholder")}
                  className="min-h-11 w-full min-w-0 rounded-xl border-0 bg-gray-100 px-4 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                  disabled={loading}
                />
              )}
              {versions.length === 0 &&
                versionId.trim() !== "" &&
                !versionIdValid && (
                  <p className="mt-1 min-w-0 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
                    {t("downloads.byId.invalidVersionId")}
                  </p>
                )}
            </div>
            <div className="min-w-0">
              <label
                className="hidden sm:block sm:invisible text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >

                {t("downloads.byId.download")}
              </label>
              <button
                type="button"
                onClick={handleLoadVersions}
                disabled={loadingVersions || loading || !account || !appIdValid}
                className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-orange-50 px-6 py-2 text-sm font-semibold text-orange-600 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-orange-950/60 dark:text-orange-400 dark:hover:bg-orange-950 sm:w-auto"
              >
                <StableLabel
                  idle={t("downloads.byId.loadVersions")}
                  busy={t("downloads.byId.loadingVersions")}
                  busyActive={loadingVersions}
                />
              </button>
            </div>
            <div className="min-w-0">
              <label
                className="hidden sm:block sm:invisible text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("downloads.byId.download")}
              </label>
              <button
                type="submit"
                disabled={loading || !account || !appIdValid || !versionIdValid}
                className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                <StableLabel
                  idle={t("downloads.byId.download")}
                  busy={t("downloads.byId.processing")}
                  busyActive={loading}
                />
              </button>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 border-t border-gray-100 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] dark:border-gray-800">
            <PlatformSelect
              value={platform}
              onChange={setPlatform}
              disabled={loading}
              className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
            />
            <Select
              value={selectedAccount}
              onChange={selectAccount}
              options={
                accounts.length > 0
                  ? accounts.map((a) => ({
                      value: a.email,
                      label: accountSelectLabel(a, t),
                    }))
                  : [
                      {
                        value: "",
                        label: t("downloads.byId.noAccountsForRegion"),
                      },
                    ]
              }
              ariaLabel={t("search.product.account")}
              disabled={loading || accounts.length === 0}
              className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
            />
          </div>
        </form>

        {queued && (
          <div className="min-w-0 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <div className="flex min-w-0 items-start gap-4">
              <AppIcon url={queued.artworkUrl} name={queued.name} size="md" />
              <div className="min-w-0 flex-1">
                <p
                  title={queued.name}
                  className="min-w-0 break-words font-medium text-gray-900 [overflow-wrap:anywhere] dark:text-white"
                >
                  {queued.name}
                </p>
                {queued.artistName && (
                  <p
                    title={queued.artistName}
                    className="min-w-0 break-words text-sm text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400"
                  >
                    {queued.artistName}
                  </p>
                )}
                <p className="min-w-0 break-all text-sm text-gray-400 dark:text-gray-500">
                  {t("downloads.byId.resolvedId", { id: queued.id })}
                  {queued.bundleID ? ` - ${queued.bundleID}` : ""}
                </p>
                {!queued.bundleID && (
                  <p className="mt-1 min-w-0 break-words text-sm text-gray-400 [overflow-wrap:anywhere] dark:text-gray-500">
                    {t("downloads.byId.notFoundNote")}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
