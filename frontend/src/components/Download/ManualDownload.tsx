import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import CountrySelect from "../common/CountrySelect";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSettingsStore } from "../../store/settings";
import { lookupAppById } from "../../api/search";
import { firstAccountCountry } from "../../utils/account";
import { countryCodeMap, storeIdToCountry } from "../../apple/config";
import type { Software } from "../../types";

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
function placeholderSoftware(id: string): Software {
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
  };
}

/**
 * Download an app from its numeric App Store id, for when the bundle id is
 * unknown or the app cannot be found by name. Same account and region selection
 * as the regular new-download page.
 */
export default function ManualDownload() {
  const { accounts } = useAccounts();
  const { defaultCountry } = useSettingsStore();
  const { t } = useTranslation();
  const { startDownload, toastDownloadError } = useDownloadAction();

  const [appId, setAppId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [country, setCountry] = useState(defaultCountry);
  const [countryTouched, setCountryTouched] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [queued, setQueued] = useState<Software | null>(null);
  const [loading, setLoading] = useState(false);

  const appIdValid = NUMERIC_ID_RE.test(appId.trim());
  const versionIdValid =
    versionId.trim() === "" || NUMERIC_ID_RE.test(versionId.trim());

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

  const filteredAccounts = useMemo(
    () => accounts.filter((a) => storeIdToCountry(a.store) === country),
    [accounts, country],
  );

  useEffect(() => {
    if (filteredAccounts.length > 0) {
      if (
        !selectedAccount ||
        !filteredAccounts.find((a) => a.email === selectedAccount)
      ) {
        setSelectedAccount(filteredAccounts[0].email);
      }
    } else if (selectedAccount !== "") {
      setSelectedAccount("");
    }
  }, [filteredAccounts, selectedAccount]);

  const account = accounts.find((a) => a.email === selectedAccount);
  const autoCountry = firstAccountCountry(accounts);

  useEffect(() => {
    if (countryTouched) return;
    const nextCountry = autoCountry ?? defaultCountry;
    if (nextCountry && nextCountry !== country) {
      setCountry(nextCountry);
    }
  }, [autoCountry, country, countryTouched, defaultCountry]);

  async function handleDownload(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !appIdValid || !versionIdValid) return;

    const id = appId.trim();
    let target = placeholderSoftware(id);
    setLoading(true);
    try {
      // Best effort: the catalogue names the app and supplies its bundle id.
      // It is not required, so a miss must not block the download.
      const resolved = await lookupAppById(id, country).catch(() => null);
      if (resolved) target = resolved;
      setQueued(target);

      await startDownload(account, target, versionId.trim() || undefined);
    } catch (err) {
      toastDownloadError(account, target, err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageContainer title={t("downloads.manual.title")}>
      <div className="min-w-0 space-y-6">
        <form
          onSubmit={handleDownload}
          className="min-w-0 space-y-4 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-5"
        >
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label
                htmlFor="manual-app-id"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("downloads.manual.appId")}
              </label>
              <input
                id="manual-app-id"
                type="text"
                inputMode="numeric"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder={t("downloads.manual.appIdPlaceholder")}
                className="min-h-11 w-full min-w-0 rounded-xl border-0 bg-gray-100 px-4 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                disabled={loading}
              />
              {appId.trim() !== "" && !appIdValid && (
                <p className="mt-1 min-w-0 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
                  {t("downloads.manual.invalidAppId")}
                </p>
              )}
            </div>
            <div className="min-w-0">
              <label
                htmlFor="manual-version-id"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("downloads.manual.versionId")}
              </label>
              <input
                id="manual-version-id"
                type="text"
                inputMode="numeric"
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                placeholder={t("downloads.manual.versionIdPlaceholder")}
                className="min-h-11 w-full min-w-0 rounded-xl border-0 bg-gray-100 px-4 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
                disabled={loading}
              />
              {versionId.trim() !== "" && !versionIdValid && (
                <p className="mt-1 min-w-0 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
                  {t("downloads.manual.invalidVersionId")}
                </p>
              )}
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <CountrySelect
              value={country}
              onChange={(v) => {
                setCountry(v);
                setCountryTouched(true);
              }}
              availableCountryCodes={availableCountryCodes}
              allCountryCodes={allCountryCodes}
              disabled={loading}
              className="min-h-11 w-full min-w-0 max-w-full truncate disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 dark:disabled:bg-gray-800/50 dark:disabled:text-gray-400"
            />
            <select
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              className="min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white"
              disabled={loading || filteredAccounts.length === 0}
            >
              {filteredAccounts.length > 0 ? (
                filteredAccounts.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.firstName} {a.lastName} ({a.email})
                  </option>
                ))
              ) : (
                <option value="">
                  {t("downloads.manual.noAccountsForRegion")}
                </option>
              )}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading || !account || !appIdValid || !versionIdValid}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {loading
              ? t("downloads.manual.processing")
              : t("downloads.manual.download")}
          </button>
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
                  {t("downloads.manual.resolvedId", { id: queued.id })}
                  {queued.bundleID ? ` - ${queued.bundleID}` : ""}
                </p>
                {!queued.bundleID && (
                  <p className="mt-1 min-w-0 break-words text-sm text-gray-400 [overflow-wrap:anywhere] dark:text-gray-500">
                    {t("downloads.manual.notFoundNote")}
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
