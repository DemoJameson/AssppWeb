import { type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { isPreviewDownloadTask } from './previewTasks';
import { useToastStore } from '../../store/toast';
import { apiGet } from '../../api/client';
import { getInstallInfo } from '../../api/install';
import type { DownloadTask } from '../../types';

interface PackageQuickActionsProps {
  task: DownloadTask;
  size?: 'compact' | 'default';
}

const iconClassName = 'h-4 w-4 shrink-0';

export function dangerButtonClass(size: 'compact' | 'default' = 'default'): string {
  const minH = size === 'compact' ? 'min-h-10' : 'min-h-11';
  const border = size === 'compact' ? 'border-red-200' : 'border-red-300';
  return `${minH} min-w-0 inline-flex items-center justify-center rounded-lg ${border} border px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40`;
}

export default function PackageQuickActions({
  task,
  size = 'default',
}: PackageQuickActionsProps) {
  const { t } = useTranslation();
  const addToast = useToastStore((state) => state.addToast);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  if (task.status !== 'completed' || !task.hasFile) return null;

  const installInfo = getInstallInfo(task.id);
  const isPreview = isPreviewDownloadTask(task);
  const buttonSize =
    size === 'compact'
      ? 'min-h-10 px-2 text-sm'
      : 'min-h-11 px-3 text-base';
  const secondaryButton = `${buttonSize} inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white font-medium text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800`;

  function showPreviewNotice() {
    addToast(
      t('downloads.preview.actionHint'),
      'info',
      t('downloads.preview.badge'),
    );
  }

  function handleInstall(event: MouseEvent<HTMLAnchorElement>) {
    if (isPreview) {
      event.preventDefault();
      showPreviewNotice();
      return;
    }

    addToast(
      task.software.name,
      'info',
      t('toast.title.installStarted'),
    );
  }

  async function handleShare() {
    if (isPreview) {
      showPreviewNotice();
      return;
    }

    try {
      await copyText(installInfo.installUrl);
      addToast(
        t('downloads.package.copied'),
        'success',
        t('toast.title.shareAcquired'),
      );

      if (navigator.share) {
        await navigator.share({
          title: task.software.name,
          text: installInfo.installUrl,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      addToast(
        t('downloads.package.shareFailed'),
        'error',
        t('downloads.package.share'),
      );
    }
  }

  function handleMouseEnter() {
    if (isPreview) return;
    const params = new URLSearchParams({ accountHash: task.accountHash });
    apiGet<{ url: string }>(
      `/api/packages/${task.id}/file-url?${params}`,
    )
      .then(({ url }) => setDownloadUrl(resolveDownloadUrl(url)))
      .catch(() => {});
  }

  async function handleDownloadClick(event: MouseEvent<HTMLAnchorElement>) {
    if (isPreview) {
      event.preventDefault();
      showPreviewNotice();
      return;
    }

    addToast(
      task.software.name,
      'info',
      t('toast.title.downloadIpaStarted'),
    );

    // If the URL was prefetched on hover and is still valid, let the browser
    // navigate — IDM and other download extensions intercept the <a> click.
    if (downloadUrl && !isUrlExpired(downloadUrl)) return;

    // URL missing, expired, or no prior hover: fetch a fresh one and navigate.
    // res.download sets Content-Disposition: attachment, so the browser
    // downloads rather than leaves the page.
    event.preventDefault();
    try {
      const params = new URLSearchParams({ accountHash: task.accountHash });
      const { url } = await apiGet<{ url: string }>(
        `/api/packages/${task.id}/file-url?${params}`,
      );
      window.location.assign(resolveDownloadUrl(url));
    } catch {
      addToast(
        t('downloads.package.downloadFailed'),
        'error',
        t('downloads.package.downloadIpa'),
      );
    }
  }

  return (
    <div
      className="grid min-w-0 grid-cols-3 gap-2"
      aria-label={t('downloads.package.quickActions')}
      data-testid="package-quick-actions"
    >
      <a
        href={installInfo.installUrl}
        onClick={handleInstall}
        className={`${buttonSize} inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg bg-blue-600 font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900`}
        aria-label={t('downloads.package.install')}
      >
        <InstallIcon />
        <span className="truncate">{t('downloads.package.installShort')}</span>
      </a>

      <div className="group relative min-w-0">
        <button
          type="button"
          onClick={handleShare}
          aria-describedby={isPreview ? undefined : `install-qr-${task.id}`}
          className={`${secondaryButton} w-full`}
          aria-label={t('downloads.package.share')}
        >
          <ShareIcon />
          <span className="truncate">{t('downloads.package.share')}</span>
        </button>
        {!isPreview && (
          <div
            id={`install-qr-${task.id}`}
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 opacity-0 transition-opacity duration-200 md:invisible md:block md:group-hover:visible md:group-hover:opacity-100 md:group-focus-within:visible md:group-focus-within:opacity-100"
          >
            <div className="flex flex-col items-center rounded-lg border border-gray-200 bg-white p-2 text-gray-500 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              <QRCodeSVG
                value={installInfo.installUrl}
                size={128}
                className="mb-1 rounded bg-white p-1"
              />
              <span className="mt-1 whitespace-nowrap text-xs">
                {t('downloads.package.scan')}
              </span>
              <span className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900" />
            </div>
          </div>
        )}
      </div>

      <a
        href={downloadUrl || '#'}
        onClick={handleDownloadClick}
        onMouseEnter={handleMouseEnter}
        download={downloadUrl ? packageFileName(task) : undefined}
        className={secondaryButton}
        aria-label={t('downloads.package.downloadIpa')}
      >
        <DownloadIcon />
        <span className="truncate">{t('downloads.package.downloadShort')}</span>
      </a>
    </div>
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  document.execCommand('copy');
  textArea.remove();
}

function packageFileName(task: DownloadTask): string {
  const unsafeName = `${task.software.name}_${task.software.version}`;
  const safeName = unsafeName.replace(/[\\/:*?"<>|]/g, '-');
  return `${safeName}.ipa`;
}

function isUrlExpired(url: string): boolean {
  try {
    const exp = new URL(url, window.location.origin).searchParams.get('exp');
    if (!exp) return false;
    return Number(exp) < Date.now();
  } catch {
    return false;
  }
}

function resolveDownloadUrl(url: string): string {
  const base = import.meta.env.DEV
    ? 'http://localhost:8080'
    : window.location.origin;
  return new URL(url, base).href;
}

function InstallIcon() {
  return (
    <svg
      aria-hidden="true"
      className={iconClassName}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      className={iconClassName}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 12v7a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-7M12 3v12m0-12 4 4m-4-4L8 7"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      className={iconClassName}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"
      />
    </svg>
  );
}
