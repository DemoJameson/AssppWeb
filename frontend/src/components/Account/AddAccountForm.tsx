import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Spinner from "../common/Spinner";
import SapStatus from "../common/SapStatus";
import { useAccounts } from "../../hooks/useAccounts";
import { useToastStore } from "../../store/toast";
import { useSapStore } from "../../store/sap";
import { authenticate, AuthenticationError } from "../../apple/authenticate";
import { getErrorMessage } from "../../utils/error";
import { generateDeviceId } from "../../apple/config";

export default function AddAccountForm() {
  const navigate = useNavigate();
  const { addAccount } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const sapStage = useSapStore((state) => state.stage);
  const sapPercent = useSapStore((state) => state.percent);

  const [appleId, setAppleId] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [deviceId, setDeviceId] = useState(() => generateDeviceId());
  const [needsCode, setNeedsCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputClassName =
    "block min-h-11 w-full min-w-0 max-w-full rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white";

  /**
   * What the submit button says while it waits: the signer's own stage first —
   * the first run downloads its assets before anything can be signed — then
   * the ordinary busy label. After the signer failed, the same button is the
   * retry: it relabels, and submitting runs the whole sign-in again.
   */
  function submitLabel(): string {
    if (loading && sapStage === "assets") {
      return t("accounts.addForm.preparingAssets", {
        percent: sapPercent ?? 0,
      });
    }
    if (loading && sapStage === "setup") {
      return t("accounts.addForm.preparingSigner");
    }
    if (!loading && sapStage === "error") {
      return t("accounts.addForm.retrySignIn");
    }
    return needsCode
      ? t("accounts.addForm.verify")
      : t("accounts.addForm.signIn");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitAccount();
  }

  async function submitAccount() {
    setLoading(true);

    try {
      const cleanedDeviceId = deviceId.replace(/[: ]/g, "");
      setDeviceId(cleanedDeviceId);

      // A pasted phone number carries its own separators, and this value becomes
      // the account's key — leaving them in stores one account twice over.
      const cleanedAppleId = appleId.trim();

      const account = await authenticate(
        cleanedAppleId,
        password,
        needsCode && code ? code : undefined,
        undefined,
        cleanedDeviceId,
      );
      await addAccount(account);
      addToast(t("accounts.addForm.addSuccess"), "success");
      navigate("/accounts");
    } catch (err) {
      if (err instanceof AuthenticationError && err.codeRequired) {
        setNeedsCode(true);
        addToast(err.message, "error");
      } else {
        addToast(
          getErrorMessage(err, t("accounts.addForm.authFailed")),
          "error",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageContainer title={t("accounts.addForm.title")}>
      <div className="max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <section className="space-y-5 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <div>
              <label
                htmlFor="appleId"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 pl-3"
              >
                {t("accounts.addForm.appleId")}
              </label>
              <input
                id="appleId"
                type="text"
                required
                value={appleId}
                onChange={(e) => setAppleId(e.target.value)}
                disabled={loading}
                placeholder={t("accounts.addForm.appleIdPlaceholder")}
                className={inputClassName}
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 pl-3"
              >
                {t("accounts.addForm.password")}
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className={inputClassName}
              />
            </div>

            <div>
              <label
                htmlFor="deviceId"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 pl-3"
              >
                {t("accounts.addForm.deviceId")}
              </label>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <input
                  id="deviceId"
                  type="text"
                  required
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={loading || needsCode}
                  className={`${inputClassName} min-w-0 flex-1 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => setDeviceId(generateDeviceId())}
                  disabled={loading || needsCode}
                  className="min-h-11 w-full shrink-0 whitespace-normal rounded-full bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:whitespace-nowrap dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  {t("accounts.addForm.randomize")}
                </button>
              </div>
              <p className="mt-1 pl-3 text-xs text-gray-500 dark:text-gray-400">
                {t("accounts.addForm.deviceIdHelp")}
              </p>
            </div>

            {needsCode && (
              <div>
                <label
                  htmlFor="code"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 pl-3"
                >
                  {t("accounts.addForm.code")}
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={loading}
                  placeholder={t("accounts.addForm.codePlaceholder")}
                  className={inputClassName}
                  autoFocus
                />
                <p className="mt-1 pl-3 text-xs text-gray-500 dark:text-gray-400">
                  {t("accounts.addForm.codeHelp")}
                </p>
              </div>
            )}
          </section>

          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-center">
              <button
                type="submit"
                disabled={loading}
                className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading && <Spinner />}
                {submitLabel()}
              </button>
              <button
                type="button"
                onClick={() => navigate("/accounts")}
                disabled={loading}
                className="min-h-11 rounded-full bg-gray-200 px-6 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t("accounts.addForm.cancel")}
              </button>
            </div>
            <SapStatus />
          </div>
        </form>
      </div>
    </PageContainer>
  );
}
