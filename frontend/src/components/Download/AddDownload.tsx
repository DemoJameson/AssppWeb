import { useState } from "react";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import PlatformSelect from "../common/PlatformSelect";

import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSelectedAccount } from "../../hooks/useSelectedAccount";
import { useVersionMetadataMap } from "../../hooks/useVersionMetadata";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { lookupApp } from "../../api/search";
import { listVersions } from "../../apple/versionFinder";
import { accountSelectLabel, accountStoreCountry } from "../../utils/account";
import { getErrorMessage } from "../../utils/error";
import { versionOptionLabel } from "../../utils/versionLabels";
import type { Platform, Software } from "../../types";

export default function AddDownload() {
  const { accounts, updateAccount } = useAccounts();
  const { defaultCountry, defaultPlatform } = useSettingsStore();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  } = useDownloadAction();
  const { versionMeta, ensureLoaded } = useVersionMetadataMap();

  const [bundleId, setBundleId] = useState("");
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const { selectedAccount, selectAccount } = useSelectedAccount(accounts);
  const [app, setApp] = useState<Software | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [step, setStep] = useState<"lookup" | "ready" | "versions">("lookup");
  const [loadingAction, setLoadingAction] = useState<
    "lookup" | "license" | "versions" | "download" | null
  >(null);

  const isLoading = loadingAction !== null;

  const account = accounts.find((a) => a.email === selectedAccount);
  const country = account
    ? (accountStoreCountry(account) ?? defaultCountry)
    : defaultCountry;

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!bundleId.trim()) return;
    setLoadingAction("lookup");
    try {
      const result = await lookupApp(bundleId.trim(), country, platform);
      if (!result) {
        addToast(t("downloads.add.notFound"), "error");
        return;
      }
      // The catalogue knows the app; the platform is what the user chose.
      setApp({ ...result, platform });
      setStep("ready");
    } catch (e) {
      addToast(getErrorMessage(e, t("downloads.add.lookupFailed")), "error");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleGetLicense() {
    if (!account || !app) return;
    setLoadingAction("license");
    try {
      await acquireLicense(account, app);
    } catch (e) {
      toastLicenseError(account, app, e);
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleLoadVersions() {
    if (!account || !app) return;
    setLoadingAction("versions");
    try {
      const result = await listVersions(account, app);
      setVersions(result.versions);
      setSelectedVersion(result.versions[0] || "");
      await ensureLoaded(app.id);
      await updateAccount({ ...account, cookies: result.updatedCookies });
      setStep("versions");
    } catch (e) {
      addToast(getErrorMessage(e, t("downloads.add.versionsFailed")), "error");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDownload() {
    if (!account || !app) return;
    setLoadingAction("download");
    try {
      await startDownload(account, app, selectedVersion || undefined);
    } catch (e) {
      toastDownloadError(account, app, e);
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <PageContainer title={t("downloads.add.title")}>
      <div className="min-w-0 space-y-6">
        <form
          onSubmit={handleLookup}
          className="min-w-0 space-y-4 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-5"
        >
          <div className="min-w-0">
            <label
              htmlFor="add-bundle-id"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t("downloads.add.bundleId")}
            </label>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-start">
              <input
                id="add-bundle-id"
                type="text"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder={t("downloads.add.placeholder")}
                className="min-h-11 w-full min-w-0 rounded-xl border-0 bg-gray-100 px-4 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading || !bundleId.trim()}
                className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
              >
                {loadingAction === "lookup"
                  ? t("downloads.add.lookingUp")
                  : t("downloads.add.lookup")}
              </button>
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <PlatformSelect
              value={platform}
              onChange={setPlatform}
              disabled={isLoading}
              className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
            />
            <select
              value={selectedAccount}
              onChange={(e) => selectAccount(e.target.value)}
              className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
              disabled={isLoading || accounts.length === 0}
            >
              {accounts.length > 0 ? (
                accounts.map((a) => (
                  <option key={a.email} value={a.email}>
                    {accountSelectLabel(a, t)}
                  </option>
                ))
              ) : (
                <option value="">
                  {t("downloads.add.noAccountsForRegion")}
                </option>
              )}
            </select>
          </div>
        </form>

        {!app && !isLoading && (
          <div className="flex min-w-0 flex-col items-center justify-center rounded-3xl bg-white px-5 py-14 text-center shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:px-6">
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
                  d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h3 className="mb-2 min-w-0 break-words text-center text-lg font-semibold text-gray-900 [overflow-wrap:anywhere] dark:text-white">
              {t("downloads.add.emptyTitle")}
            </h3>
            <p className="max-w-sm min-w-0 break-words text-center text-sm text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">
              {t("downloads.add.emptyDesc")}
            </p>
          </div>
        )}

        {app && (
          <div className="min-w-0 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <div className="mb-4 flex min-w-0 items-start gap-4">
              <AppIcon url={app.artworkUrl} name={app.name} size="md" />
              <div className="min-w-0 flex-1">
                <p
                  title={app.name}
                  className="min-w-0 break-words font-medium text-gray-900 [overflow-wrap:anywhere] dark:text-white"
                >
                  {app.name}
                </p>
                <p
                  title={app.artistName}
                  className="min-w-0 break-words text-sm text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400"
                >
                  {app.artistName}
                </p>
                <p
                  title={`${app.version} - ${app.formattedPrice ?? t("search.product.free")}`}
                  className="min-w-0 break-all text-sm text-gray-400 dark:text-gray-500"
                >
                  v{app.version} -{" "}
                  {app.formattedPrice ?? t("search.product.free")}
                </p>
              </div>
            </div>

            {step === "versions" && versions.length > 0 && (
              <div className="mb-4 min-w-0">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t("downloads.add.versionOptional")}
                </label>
                <select
                  value={selectedVersion}
                  onChange={(e) => setSelectedVersion(e.target.value)}
                  className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                >
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      {versionOptionLabel(v, versionMeta[v])}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              {(app.price === undefined || app.price === 0) && (
                <button
                  onClick={handleGetLicense}
                  disabled={isLoading || !account}
                  className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto dark:bg-blue-950/60 dark:text-blue-400"
                >
                  {loadingAction === "license"
                    ? t("downloads.add.processing")
                    : t("downloads.add.getLicense")}
                </button>
              )}
              {step !== "versions" && (
                <button
                  onClick={handleLoadVersions}
                  disabled={isLoading || !account}
                  className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  {loadingAction === "versions"
                    ? t("downloads.add.processing")
                    : t("downloads.add.selectVersion")}
                </button>
              )}
              <button
                onClick={handleDownload}
                disabled={isLoading || !account}
                className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                {loadingAction === "download"
                  ? t("downloads.add.processing")
                  : t("downloads.add.download")}
              </button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
