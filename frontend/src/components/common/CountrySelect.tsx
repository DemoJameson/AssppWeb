import { useTranslation } from 'react-i18next';
import Select from './Select';

export default function CountrySelect({
  value,
  onChange,
  availableCountryCodes,
  allCountryCodes,
  disabled,
  id,
  className = '',
  wrapperClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  availableCountryCodes: string[];
  allCountryCodes: string[];
  disabled?: boolean;
  /** Lets a caller's <label> point at this select. */
  id?: string;
  className?: string;
  wrapperClassName?: string;
}) {
  const { t } = useTranslation();

  const options = [
    ...availableCountryCodes.map((code) => ({
      value: code,
      label: `${t(`countries.${code}`, code)} (${code})`,
      group: t('regions.available'),
    })),
    ...allCountryCodes.map((code) => ({
      value: code,
      label: `${t(`countries.${code}`, code)} (${code})`,
      group: t('regions.all'),
    })),
  ];

  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      ariaLabel={t('regions.all')}
      className={`w-full rounded-xl border border-gray-300/90 bg-gray-100 px-3.5 py-2.5 text-base text-gray-900 shadow-sm shadow-gray-950/5 outline-none transition-colors focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:shadow-black/20 dark:focus:border-blue-400 dark:focus:ring-blue-400/15 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${className}`}
      wrapperClassName={wrapperClassName}
    />
  );
}
