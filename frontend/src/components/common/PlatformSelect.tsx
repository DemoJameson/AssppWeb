import { useTranslation } from "react-i18next";
import { PLATFORMS, PLATFORM_LABELS } from "../../apple/platform";
import type { Platform } from "../../types";

interface PlatformSelectProps {
  value: Platform;
  onChange: (value: Platform) => void;
  disabled?: boolean;
  className?: string;
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
  id,
}: PlatformSelectProps) {
  const { t } = useTranslation();

  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as Platform)}
      disabled={disabled}
      className={className}
      aria-label={t("downloads.platform.label")}
    >
      {PLATFORMS.map((platform) => (
        <option key={platform} value={platform}>
          {PLATFORM_LABELS[platform]}
        </option>
      ))}
    </select>
  );
}
