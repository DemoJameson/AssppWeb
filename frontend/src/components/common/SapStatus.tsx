import { useTranslation } from "react-i18next";
import { useSapStore } from "../../store/sap";

/**
 * What the SAP signer is doing, for screens with a button that will wait on
 * it. The line is absolutely positioned so its appearance never displaces the
 * layout: it floats in the gap between the page title and the card below
 * (the mounted form is the positioned ancestor), sitting clear of the card's
 * top edge. Renders nothing when idle or ready.
 */
export default function SapStatus() {
  const { t } = useTranslation();
  const stage = useSapStore((state) => state.stage);
  const percent = useSapStore((state) => state.percent);
  const error = useSapStore((state) => state.error);

  if (stage === "idle" || stage === "ready") {
    return null;
  }

  if (stage === "error") {
    const message = t("accounts.addForm.signerFailed", { error: error ?? "" });
    return (
      <span
        title={message}
        className="absolute -top-6 left-0 max-w-full truncate text-sm text-red-600 dark:text-red-400"
      >
        {message}
      </span>
    );
  }

  return (
    <span className="absolute -top-6 left-0 max-w-full truncate text-sm text-gray-600 dark:text-gray-400">
      {stage === "assets"
        ? t("accounts.addForm.preparingAssets", { percent: percent ?? 0 })
        : t("accounts.addForm.preparingSigner")}
    </span>
  );
}
