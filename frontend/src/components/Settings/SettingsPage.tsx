import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Modal from "../common/Modal";
import Select from "../common/Select";
import { useAccountsStore } from "../../store/accounts";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { apiGet } from "../../api/client";
import { encryptData, decryptData } from "../../utils/crypto";
import { PLATFORMS, PLATFORM_LABELS } from "../../apple/platform";
import { countryCodeMap } from "../../apple/config";
import type { Account } from "../../types";

// Where the "Build Commit" row links: this repository's commit browser.
const REPO_COMMIT_BASE = "https://github.com/DemoJameson/AssppWeb/commit/";

interface ServerInfo {
  uptime?: number;
  buildCommit?: string;
  buildDate?: string;
  port?: number;
  dataDir?: string;
  publicBaseUrl?: string;
  disableHttpsRedirect?: boolean;
  autoCleanupDays?: number;
  autoCleanupMaxMB?: number;
  maxDownloadMB?: number;
  downloadThreads?: number;
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { accounts, addAccount, updateAccount } = useAccountsStore();
  const {
    defaultCountry,
    setDefaultCountry,
    defaultPlatform,
    setDefaultPlatform,
    autoFetchVersionInfo,
    setAutoFetchVersionInfo,
    autoAcquireLicense,
    setAutoAcquireLicense,
  } = useSettingsStore();
  const addToast = useToastStore((s) => s.addToast);

  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [commitCopied, setCommitCopied] = useState(false);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [exportConfirmPassword, setExportConfirmPassword] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFileData, setImportFileData] = useState("");

  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [pendingAccounts, setPendingAccounts] = useState<Account[]>([]);
  const [conflictStats, setConflictStats] = useState({ conflict: 0, new: 0 });

  useEffect(() => {
    apiGet<ServerInfo>("/api/settings")
      .then(setServerInfo)
      .catch(() => setServerInfo(null));
  }, []);

  const handleCopyCommit = async () => {
    const commit = serverInfo?.buildCommit;
    if (!commit) return;
    try {
      await navigator.clipboard.writeText(commit);
      setCommitCopied(true);
      window.setTimeout(() => setCommitCopied(false), 1500);
    } catch {
      // Clipboard unavailable (non-secure context): nothing to do.
    }
  };

  const sortedCountries = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const handleExport = async () => {
    if (exportPassword !== exportConfirmPassword) {
      addToast(t("settings.data.passwordMismatch"), "error");
      return;
    }
    try {
      const encrypted = await encryptData(accounts, exportPassword);
      const blob = new Blob([encrypted], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "asspp-accounts.enc";
      a.click();
      URL.revokeObjectURL(url);

      setExportModalOpen(false);
      setExportPassword("");
      setExportConfirmPassword("");
      addToast(t("settings.data.exportSuccess"), "success");
    } catch {
      addToast(t("settings.data.exportFailed"), "error");
    }
  };

  // Native confirm() is not blocking in embedded browsers (Trae's built-in
  // browser returns true immediately while still drawing the dialog), so the
  // destructive clear-all is confirmed through the in-app modal instead.
  const handleConfirmClear = () => {
    setClearModalOpen(false);
    localStorage.clear();
    indexedDB.deleteDatabase("asspp-accounts");
    addToast(t("settings.data.cleared"), "success");
    setTimeout(() => {
      window.location.href = "/";
    }, 1000);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setImportFileData(content);
      setImportModalOpen(true);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImport = async () => {
    try {
      const parsed = await decryptData(importFileData, importPassword);
      if (!Array.isArray(parsed)) throw new Error("Invalid format");
      const valid = parsed.filter(
        (item: any) =>
          item &&
          typeof item === "object" &&
          typeof item.email === "string" &&
          item.email.length > 0,
      ) as Account[];
      if (valid.length === 0) throw new Error("No valid accounts found");

      if (accounts.length === 0) {
        for (const acc of valid) {
          await addAccount(acc);
        }
        addToast(t("settings.data.importSuccess"), "success");
        setImportModalOpen(false);
        setImportPassword("");
      } else {
        let conflictCount = 0;
        let newCount = 0;
        valid.forEach((imported) => {
          if (accounts.some((a) => a.email === imported.email)) conflictCount++;
          else newCount++;
        });

        if (conflictCount > 0) {
          setConflictStats({ conflict: conflictCount, new: newCount });
          setPendingAccounts(valid);
          setImportModalOpen(false);
          setImportPassword("");
          setConflictModalOpen(true);
        } else {
          for (const acc of valid) {
            await addAccount(acc);
          }
          addToast(t("settings.data.importSuccess"), "success");
          setImportModalOpen(false);
          setImportPassword("");
        }
      }
    } catch {
      addToast(t("settings.data.incorrectPassword"), "error");
    }
  };

  const handleResolveConflict = async (overwrite: boolean) => {
    for (const imported of pendingAccounts) {
      const exists = accounts.some((a) => a.email === imported.email);
      if (exists) {
        if (overwrite) await updateAccount(imported);
      } else {
        await addAccount(imported);
      }
    }
    setConflictModalOpen(false);
    setPendingAccounts([]);
    addToast(t("settings.data.importSuccess"), "success");
  };

  return (
    <PageContainer title={t("settings.title")}>
      <div className="min-w-0 space-y-6">
        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t("settings.language.title")}
          </h2>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="language"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("settings.language.label")}
              </label>
              <Select
                id="language"
                value={i18n.resolvedLanguage || "en-US"}
                onChange={async (value) => {
                  await i18n.changeLanguage(value);
                  addToast(t("settings.language.changed"), "success");
                }}
                options={[
                  { value: "en-US", label: "English (US)" },
                  { value: "zh-CN", label: "简体中文" },
                  { value: "zh-TW", label: "繁體中文" },
                  { value: "ja", label: "日本語" },
                  { value: "ko", label: "한국어" },
                  { value: "ru", label: "Русский" },
                ]}
                className="block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              />
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t("settings.defaults.title")}
          </h2>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="country"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("settings.defaults.country")}
              </label>
              <Select
                id="country"
                value={defaultCountry}
                onChange={(value) => {
                  setDefaultCountry(value);
                  addToast(t("settings.defaults.countryChanged"), "success");
                }}
                options={sortedCountries.map((code) => ({
                  value: code,
                  label: `${t(`countries.${code}`, code)} (${code})`,
                }))}
                className="block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              />
            </div>
            <div>
              <label
                htmlFor="platform"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("settings.defaults.platform")}
              </label>
              <Select
                id="platform"
                value={defaultPlatform}
                onChange={(value) => {
                  setDefaultPlatform(value as typeof defaultPlatform);
                  addToast(t("settings.defaults.platformChanged"), "success");
                }}
                options={PLATFORMS.map((platform) => ({
                  value: platform,
                  label: PLATFORM_LABELS[platform],
                }))}
                className="block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              />
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t("settings.automation.title")}
          </h2>
          <div className="space-y-4">
            <SettingsToggle
              label={t("settings.automation.autoVersionInfo")}
              description={t("settings.automation.autoVersionInfoDesc")}
              checked={autoFetchVersionInfo}
              onChange={setAutoFetchVersionInfo}
            />
            <SettingsToggle
              label={t("settings.automation.autoLicense")}
              description={t("settings.automation.autoLicenseDesc")}
              checked={autoAcquireLicense}
              onChange={setAutoAcquireLicense}
            />
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t("settings.server.title")}
          </h2>
          {serverInfo ? (
            <div className="min-w-0 space-y-6">
              <dl className="min-w-0 divide-y divide-gray-100 dark:divide-gray-800">
                {serverInfo.uptime != null && (
                  <SettingsInfoRow label={t("settings.server.uptime")}>
                    {formatUptime(serverInfo.uptime)}
                  </SettingsInfoRow>
                )}
              </dl>

              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                  {t("settings.server.configuration")}
                </h3>
                <dl className="min-w-0 divide-y divide-gray-100 border-y border-gray-100 dark:divide-gray-800 dark:border-gray-800">
                  <SettingsInfoRow label="PORT" mono>
                    {serverInfo.port}
                  </SettingsInfoRow>
                  <SettingsInfoRow
                    label="DATA_DIR"
                    mono
                    valueTitle={serverInfo.dataDir}
                  >
                    {serverInfo.dataDir}
                  </SettingsInfoRow>
                  <SettingsInfoRow
                    label="PUBLIC_BASE_URL"
                    mono
                    valueTitle={serverInfo.publicBaseUrl || undefined}
                  >
                    {serverInfo.publicBaseUrl || (
                      <span className="italic text-gray-400 dark:text-gray-500">
                        {t("settings.server.notSet")}
                      </span>
                    )}
                  </SettingsInfoRow>
                  <SettingsInfoRow
                    label="UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT"
                    mono
                  >
                    {serverInfo.disableHttpsRedirect
                      ? t("settings.server.enabled")
                      : t("settings.server.disabled")}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="AUTO_CLEANUP_DAYS" mono>
                    {serverInfo.autoCleanupDays ||
                      t("settings.server.disabled")}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="AUTO_CLEANUP_MAX_MB" mono>
                    {serverInfo.autoCleanupMaxMB ||
                      t("settings.server.disabled")}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="MAX_DOWNLOAD_MB" mono>
                    {serverInfo.maxDownloadMB ||
                      t("settings.server.disabled")}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="DOWNLOAD_THREADS" mono>
                    {serverInfo.downloadThreads ?? 8}
                  </SettingsInfoRow>
                </dl>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("settings.server.offline")}
            </p>
          )}
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t("settings.data.title")}
          </h2>
          <p className="mb-4 max-w-full whitespace-nowrap text-[clamp(0.5625rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-600 dark:text-gray-400">
            {t("settings.data.description")}
          </p>

          <div className="mb-6 grid w-full min-w-0 grid-cols-2 gap-3 sm:max-w-sm">
            <button
              onClick={() => setExportModalOpen(true)}
              className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-blue-300 px-3 py-2 text-center text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 sm:px-4 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/30"
            >
              {t("settings.data.exportBtn")}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-green-300 px-3 py-2 text-center text-sm font-medium text-green-600 transition-colors hover:bg-green-50 sm:px-4 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/30"
            >
              {t("settings.data.importBtn")}
            </button>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".enc"
              onChange={handleFileSelect}
            />
          </div>

          <button
            onClick={() => setClearModalOpen(true)}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-red-300 px-4 py-2 text-center text-sm font-medium text-red-600 transition-colors hover:bg-red-50 sm:w-auto dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
          >
            {t("settings.data.button")}
          </button>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t("settings.about.title")}
          </h2>
          <p className="max-w-full whitespace-nowrap text-[clamp(0.5625rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-600 dark:text-gray-400">
            {t("settings.about.description")}
          </p>
          {serverInfo && (
            <dl className="mt-3 min-w-0 divide-y divide-gray-100 dark:divide-gray-800">
              {serverInfo.buildCommit &&
                serverInfo.buildCommit !== "unknown" && (
                  <SettingsInfoRow
                    label={t("settings.about.buildCommit")}
                    mono
                    compact
                    valueTitle={serverInfo.buildCommit}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <a
                        href={`${REPO_COMMIT_BASE}${serverInfo.buildCommit}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-0.5 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                      >
                        <span className="truncate">
                          {serverInfo.buildCommit.slice(0, 7)}
                        </span>
                        <ExternalLinkIcon />
                      </a>
                      <button
                        type="button"
                        onClick={handleCopyCommit}
                        title={t("settings.about.copyCommit")}
                        aria-label={t("settings.about.copyCommit")}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
                      >
                        {commitCopied ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </span>
                  </SettingsInfoRow>
                )}
              {serverInfo.buildDate && serverInfo.buildDate !== "unknown" && (
                <SettingsInfoRow
                  label={t("settings.about.buildDate")}
                  compact
                  valueTitle={serverInfo.buildDate}
                >
                    {new Date(serverInfo.buildDate).toLocaleString()}
                </SettingsInfoRow>
              )}
            </dl>
          )}
        </section>
      </div>

      <Modal
        open={clearModalOpen}
        onClose={() => setClearModalOpen(false)}
        title={t("settings.data.confirmTitle")}
      >
        <div className="min-w-0 space-y-4">
          <p className="min-w-0 break-words text-sm text-gray-600 dark:text-gray-300">
            {t("settings.data.confirm")}
          </p>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setClearModalOpen(false)}
              className="min-h-11 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t("settings.data.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirmClear}
              className="min-h-11 min-w-0 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {t("settings.data.button")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        title={t("settings.data.exportBtn")}
      >
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t("settings.data.passwordPrompt")}
            </label>
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t("settings.data.passwordConfirm")}
            </label>
            <input
              type="password"
              value={exportConfirmPassword}
              onChange={(e) => setExportConfirmPassword(e.target.value)}
              className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
        </div>
        <div className="mt-6 flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
          <button
            onClick={() => setExportModalOpen(false)}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("settings.data.cancel")}
          </button>
          <button
            onClick={handleExport}
            disabled={!exportPassword || !exportConfirmPassword}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
          >
            {t("settings.data.confirmBtn")}
          </button>
        </div>
      </Modal>

      <Modal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        title={t("settings.data.importBtn")}
      >
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t("settings.data.passwordPrompt")}
            </label>
            <input
              type="password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
        </div>
        <div className="mt-6 flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
          <button
            onClick={() => setImportModalOpen(false)}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("settings.data.cancel")}
          </button>
          <button
            onClick={handleImport}
            disabled={!importPassword}
            className="min-h-11 min-w-0 whitespace-normal break-words rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
          >
            {t("settings.data.confirmBtn")}
          </button>
        </div>
      </Modal>

      <Modal
        open={conflictModalOpen}
        onClose={() => setConflictModalOpen(false)}
        title={t("settings.data.conflictTitle")}
      >
        <p className="mb-6 min-w-0 break-words text-sm leading-6 text-gray-700 dark:text-gray-300">
          {t("settings.data.conflictDesc", {
            conflict: conflictStats.conflict,
            new: conflictStats.new,
          })}
        </p>
        <div className="flex min-w-0 flex-col gap-3">
          <button
            onClick={() => handleResolveConflict(true)}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
          >
            {t("settings.data.conflictOverwrite")}
          </button>
          <button
            onClick={() => handleResolveConflict(false)}
            className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("settings.data.conflictSkip")}
          </button>
          <button
            onClick={() => setConflictModalOpen(false)}
            className="mt-2 min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("settings.data.cancel")}
          </button>
        </div>
      </Modal>
    </PageContainer>
  );
}

function SettingsToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex w-full min-w-0 items-start justify-between gap-4 text-left"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {description}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-700"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function SettingsInfoRow({
  label,
  children,
  mono = false,
  compact = false,
  valueTitle,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  compact?: boolean;
  valueTitle?: string;
}) {
  const labelSize = compact ? "text-xs" : "text-sm";
  const valueSize = compact ? "text-xs" : "text-sm";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:items-start sm:gap-6">
      <dt
        className={`${labelSize} min-w-0 break-all font-medium text-gray-500 dark:text-gray-400`}
      >
        {label}
      </dt>
      <dd
        title={valueTitle}
        className={`${valueSize} min-w-0 max-w-full whitespace-pre-wrap break-all text-gray-900 sm:text-right dark:text-gray-200 ${
          mono ? "font-mono" : ""
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M2.5 8.5l3.5 3.5 7-7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="M6.5 3h6.5v6.5" />
      <path d="M13 3 7 9" />
    </svg>
  );
}
