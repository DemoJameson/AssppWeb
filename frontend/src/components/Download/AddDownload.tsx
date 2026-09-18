import { useState } from "react";
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
import { lookupApp } from "../../api/search";
import { accountSelectLabel, accountStoreCountry } from "../../utils/account";
import { getErrorMessage } from "../../utils/error";
import { versionOptionLabel } from "../../utils/versionLabels";
import type { Platform, Software } from "../../types";

export default function AddDownload() {
  const { accounts } = useAccounts();
  const { defaultCountry, defaultPlatform } = useSettingsStore();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
    listVersionsWithLicense,
  } = useDownloadAction();
  const { versionMeta, ensureLoaded, prefetchMissing } =
    useVersionMetadataMap();

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
      const result = await listVersionsWithLicense(account, app);
      setVersions(result.versions);
      setSelectedVersion(result.versions[0] || "");
      await ensureLoaded(app.id);
      // Fill the missing labels silently in the background.
      prefetchMissing(account, app, result.versions);
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
                <StableLabel
                  idle={t("downloads.add.lookup")}
                  busy={t("downloads.add.lookingUp")}
                  busyActive={loadingAction === "lookup"}
                />
              </button>
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 border-t border-gray-100 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] dark:border-gray-800">
            <PlatformSelect
              value={platform}
              onChange={setPlatform}
              disabled={isLoading}
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
                        label: t("downloads.add.noAccountsForRegion"),
                      },
                    ]
              }
              ariaLabel={t("search.product.account")}
              disabled={isLoading || accounts.length === 0}
              className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
            />
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
                <Select
                  value={selectedVersion}
                  onChange={setSelectedVersion}
                  options={versions.map((v) => ({
                    value: v,
                    label: versionOptionLabel(v, versionMeta[v]),
                  }))}
                  ariaLabel={t("downloads.add.versionOptional")}
                  className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                />
              </div>
            )}

            <div className="grid min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              {(app.price === undefined || app.price === 0) && (
                <button
                  onClick={handleGetLicense}
                  disabled={isLoading || !account}
                  className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto dark:bg-blue-950/60 dark:text-blue-400"
                >
                  <StableLabel
                    idle={t("downloads.add.getLicense")}
                    busy={t("downloads.add.processing")}
                    busyActive={loadingAction === "license"}
                  />
                </button>
              )}
              {step !== "versions" && (
                <button
                  onClick={handleLoadVersions}
                  disabled={isLoading || !account}
                  className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-600 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-orange-950/60 dark:text-orange-400 dark:hover:bg-orange-950 sm:w-auto"
                >
                  <StableLabel
                    idle={t("downloads.add.selectVersion")}
                    busy={t("downloads.add.processing")}
                    busyActive={loadingAction === "versions"}
                  />
                </button>
              )}
              <button
                onClick={handleDownload}
                disabled={isLoading || !account}
                className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                <StableLabel
                  idle={t("downloads.add.download")}
                  busy={t("downloads.add.processing")}
                  busyActive={loadingAction === "download"}
                />
              </button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
