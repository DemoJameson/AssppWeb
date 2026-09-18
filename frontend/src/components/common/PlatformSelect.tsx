import { useTranslation } from "react-i18next";
import Select from "./Select";
import { PLATFORMS, PLATFORM_LABELS } from "../../apple/platform";
import type { Platform } from "../../types";

interface PlatformSelectProps {
  value: Platform;
  onChange: (value: Platform) => void;
  disabled?: boolean;
  className?: string;
  /** Layout styling for the wrapper (e.g. widths inside flex rows). */
  wrapperClassName?: string;
  /** Lets a caller's <label> point at this select. */
  id?: string;
}

/**
 * Which store platform's build to search for or download. Mirrors ipatool's
 * `--platform`; iOS is always the default.
 */
export default function PlatformSelect({
  value,
  onChange,
  disabled,
  className,
  wrapperClassName,
  id,
}: PlatformSelectProps) {
  const { t } = useTranslation();

  return (
    <Select
      id={id}
      value={value}
      onChange={(next) => onChange(next as Platform)}
      options={PLATFORMS.map((platform) => ({
        value: platform,
        label: PLATFORM_LABELS[platform],
      }))}
      disabled={disabled}
      className={className}
      wrapperClassName={wrapperClassName}
      ariaLabel={t("downloads.platform.label")}
    />
  );
}
