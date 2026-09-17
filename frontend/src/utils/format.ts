// macOS, iOS and modern Linux desktops (GNOME/Nautilus) use decimal units
// (1 MB = 1000^2 bytes); Windows uses binary units (1 MB = 1024^2 bytes).
// Match the host so the displayed size agrees with the platform's file manager.
export const BYTE_BASE =
  typeof navigator !== 'undefined' &&
  /Win/i.test(navigator.userAgent)
    ? 1024
    : 1000;

export function formatBytes(value?: number | string): string {
  if (value === undefined || value === null || value === '') return '—';

  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(BYTE_BASE)),
    units.length - 1,
  );
  const amount = bytes / BYTE_BASE ** unitIndex;
  const digits = unitIndex === 0 || amount >= 100 ? 0 : 1;

  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}
