import { type MouseEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { isPreviewDownloadTask } from './previewTasks';
import { useToastStore } from '../../store/toast';
import { apiGet } from '../../api/client';
import {
  getInstallInfo,
  openInstallUrl,
  type InstallInfo,
} from '../../api/install';
import Modal from '../common/Modal';
import {
  detectInstallDevice,
  installDecision,
  isAppleSiliconMac,
  type InstallDevice,
  type InstallHint,
} from '../../utils/device';
import { PLATFORM_LABELS } from '../../apple/platform';
import type { DownloadTask } from '../../types';

interface PackageQuickActionsProps {
  task: DownloadTask;
  size?: 'compact' | 'default';
}

const iconClassName = 'h-4 w-4 shrink-0';

/** Keys for the blocked dialog's next-step hint, one per reason. */
const HINT_KEYS: Record<InstallHint, string> = {
  visionPro: 'install.blocked.hintVisionPro',
  iosDevice: 'install.blocked.hintIOS',
  download: 'install.blocked.hintDownload',
};

type PendingInstall =
  | { kind: 'confirm'; device: InstallDevice }
  | {
      kind: 'blocked';
      hint: InstallHint;
      deviceName: string;
      packagePlatform: string;
    };

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
  const [installInfo, setInstallInfo] = useState<InstallInfo | null>(null);
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(
    null,
  );
  const isPreview = isPreviewDownloadTask(task);

  // The install links are signed by the server, so they are fetched rather than
  // built here (see `api/install`). Once per package: the QR code below renders
  // whatever this lands with, and a click re-mints it when the window has run
  // out — a QR scanned from another device cannot, so the window is generous.
  // A preview row stands for no task on the server, so there is nothing to ask.
  useEffect(() => {
    if (isPreview || task.status !== 'completed' || !task.hasFile) return;

    let cancelled = false;
    getInstallInfo(task.id)
      .then((info) => {
        if (!cancelled) setInstallInfo(info);
      })
      .catch(() => {
        // Left null: the buttons stay inert rather than opening a link the
        // server will refuse.
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, isPreview, task.status, task.hasFile]);

  if (task.status !== 'completed' || !task.hasFile) return null;

  /** A fresh install URL: the fetched one while its window holds, else re-minted. */
  async function resolveInstallUrl(): Promise<string> {
    if (installInfo && !isUrlExpired(installInfo.manifestUrl)) {
      return installInfo.installUrl;
    }
    const info = await getInstallInfo(task.id);
    setInstallInfo(info);
    return info.installUrl;
  }

  // No font-size utility here on purpose: the app's unlayered
  // `font: inherit` beats Tailwind on <button>, so the <a> and <button>
  // twins only stay identical when both sides inherit one size.
  const buttonSize =
    size === 'compact'
      ? 'min-h-10 px-2'
      : 'min-h-11 px-3';
  const secondaryButton = `${buttonSize} inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800`;

  function showPreviewNotice() {
    addToast(
      t('downloads.preview.actionHint'),
      'info',
      t('downloads.preview.badge'),
    );
  }

  async function handleInstall(event: MouseEvent<HTMLAnchorElement>) {
    if (isPreview) {
      event.preventDefault();
      showPreviewNotice();
      return;
    }

    // A dialog always comes first: either the overwrite notice for a device
    // that can take the package, or the reason it cannot.
    event.preventDefault();

    const device = detectInstallDevice();
    const platform = task.software.platform ?? 'ios';
    let appleSilicon = false;
    if (device.family === 'mac' && (platform === 'ios' || platform === 'ipad')) {
      appleSilicon = await isAppleSiliconMac();
    }

    const decision = installDecision(device, platform, appleSilicon);
    if (decision.kind === 'install') {
      setPendingInstall({ kind: 'confirm', device });
      return;
    }

    setPendingInstall({
      kind: 'blocked',
      hint: decision.hint,
      deviceName:
        device.name === 'browser' ? t('install.deviceBrowser') : device.name,
      packagePlatform: PLATFORM_LABELS[platform] ?? platform,
    });
  }

  async function confirmInstall() {
    setPendingInstall(null);
    try {
      // Minted before either toast: a link the server will not accept must not
      // be announced as a started install.
      const url = await resolveInstallUrl();
      addToast(task.software.name, 'info', t('toast.title.installStarted'));
      openInstallUrl(url);
    } catch {
      addToast(
        t('downloads.package.installFailed'),
        'error',
        t('downloads.package.install'),
      );
    }
  }

  function closeInstallDialog() {
    setPendingInstall(null);
  }

  async function handleShare() {
    if (isPreview) {
      showPreviewNotice();
      return;
    }

    try {
      const url = await resolveInstallUrl();
      await copyText(url);
      addToast(
        t('downloads.package.copied'),
        'success',
        t('toast.title.shareAcquired'),
      );

      if (navigator.share) {
        await navigator.share({
          title: task.software.name,
          text: url,
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
      className="grid min-w-0 grid-cols-3 gap-2 text-[15px]"
      aria-label={t('downloads.package.quickActions')}
      data-testid="package-quick-actions"
    >
      <a
        href={installInfo?.installUrl ?? '#'}
        onClick={handleInstall}
        className={`${buttonSize} inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900`}
        aria-label={t('downloads.package.install')}
      >
        <InstallIcon />
        <span className="truncate">{t('downloads.package.installShort')}</span>
      </a>

      <div className="group relative min-w-0">
        <button
          type="button"
          onClick={handleShare}
          aria-describedby={
            !isPreview && installInfo ? `install-qr-${task.id}` : undefined
          }
          className={`${secondaryButton} w-full`}
          aria-label={t('downloads.package.share')}
        >
          <ShareIcon />
          <span className="truncate">{t('downloads.package.share')}</span>
        </button>
        {!isPreview && installInfo && (
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

      <Modal
        open={pendingInstall?.kind === 'confirm'}
        onClose={closeInstallDialog}
        title={t('install.overwrite.title')}
      >
        <div className="min-w-0 space-y-4">
          <p className="min-w-0 break-words text-sm text-gray-600 dark:text-gray-300">
            {pendingInstall?.kind === 'confirm' &&
            pendingInstall.device.family === 'mac'
              ? t('install.overwrite.bodyMac')
              : t('install.overwrite.body')}
          </p>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={closeInstallDialog}
              className="min-h-11 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t('settings.data.cancel')}
            </button>
            <button
              type="button"
              onClick={confirmInstall}
              className="min-h-11 min-w-0 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              {t('install.continue')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={pendingInstall?.kind === 'blocked'}
        onClose={closeInstallDialog}
        title={t('install.blocked.title')}
      >
        <div className="min-w-0 space-y-4">
          {pendingInstall?.kind === 'blocked' && (
            <>
              <p className="min-w-0 break-words text-sm text-gray-600 dark:text-gray-300">
                {t('install.blocked.body', {
                  packagePlatform: pendingInstall.packagePlatform,
                  deviceName: pendingInstall.deviceName,
                })}
              </p>
              <p className="min-w-0 break-words text-sm text-gray-500 dark:text-gray-400">
                {t(HINT_KEYS[pendingInstall.hint])}
              </p>
            </>
          )}
          <button
            type="button"
            onClick={closeInstallDialog}
            className="min-h-11 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            {t('install.gotIt')}
          </button>
        </div>
      </Modal>
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
  if (import.meta.env.DEV) {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return new URL(url, 'http://localhost:8080').href;
    }
  }
  return new URL(url, window.location.origin).href;
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
