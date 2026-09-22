import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppIcon from '../common/AppIcon';
import Badge from '../common/Badge';
import ProgressBar from '../common/ProgressBar';
import PackageQuickActions, { dangerButtonClass } from './PackageQuickActions';
import { useAccounts } from '../../hooks/useAccounts';
import { accountStoreCountry } from '../../utils/account';
import { formatDateISO } from '../../utils/software';
import { formatBytes } from '../../utils/format';
import { taskIconUrl } from '../../utils/icon';
import { PLATFORM_LABELS } from '../../apple/platform';
import type { DownloadTask } from '../../types';

interface DownloadItemProps {
  task: DownloadTask;
  preview?: boolean;
  accountEmail?: string;
  /** Drawn when the user was led here from another page to this package. */
  highlight?: boolean;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  /**
   * Left out when the task's account is gone: a download cannot be retried
   * without one, and a button that does nothing is worse than no button.
   */
  onRetry?: (id: string) => void;
}

export default function DownloadItem({
  task,
  preview = false,
  accountEmail,
  highlight = false,
  onPause,
  onResume,
  onDelete,
  onRetry,
}: DownloadItemProps) {
  const { t } = useTranslation();
  const { accounts } = useAccounts();

  const isActive = task.status === 'downloading' || task.status === 'injecting';
  const isPaused = task.status === 'paused';
  const isFailed = task.status === 'failed';
  // Pausing is the transfer's action: once the package is on disk the server is
  // mid-package, and an abort there would keep nothing — so the button stays
  // where it is but is off, for minutes on a Mac package, rather than calling
  // something that fails.
  const canPause = task.status === 'downloading';
  // The phase after the transfer is not the same work for every package: a
  // macOS download is decrypted there, while an IPA is compiled into.
  const processingLabel =
    task.status === 'injecting' && task.software.platform === 'macos'
      ? t('downloads.status.decrypting')
      : undefined;
  const detailsHref = `/downloads/${task.id}${
    preview ? '?preview=downloads' : ''
  }`;
  // The app's own detail page, carrying the package's platform, the account
  // that owns it (its storefront travels as `country`) and the package's own
  // version id — the build the page opens on, so its 详细信息 answers for this
  // package and a build already here reads as 已下载. The state rides the
  // Link's `state` prop — the object form of `to` drops it here.
  const owningAccount = accounts.find((a) => a.email === accountEmail);
  const appDetailHref = task.software.id
    ? `/search/${task.software.id}?platform=${task.software.platform ?? 'ios'}${
        preview ? '&preview=product' : ''
      }`
    : null;
  const appDetailState =
    owningAccount || task.software.externalVersionId
      ? {
          ...(owningAccount
            ? {
                accountEmail: owningAccount.email,
                country: accountStoreCountry(owningAccount),
              }
            : {}),
          ...(task.software.externalVersionId
            ? { versionId: task.software.externalVersionId }
            : {}),
        }
      : null;

  // The version label matches the package detail view: the external build id
  // travels beside the version number, so the two pages speak of one build.
  const versionLabel = task.software.externalVersionId
    ? `${task.software.version} (${task.software.externalVersionId})`
    : task.software.version;

  return (
    <article
      id={`download-item-${task.id}`}
      className={`min-w-0 rounded-lg border border-gray-200 bg-white p-4 transition-shadow dark:border-gray-800 dark:bg-gray-900 ${
        highlight
          ? 'ring-2 ring-blue-500 dark:ring-blue-400'
          : ''
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Link
          to={appDetailHref ?? detailsHref}
          state={appDetailState ?? undefined}
          className="min-w-0 shrink-0"
        >
          <AppIcon
            url={taskIconUrl(task)}
            name={task.software.name}
            size="sm"
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Link
                to={appDetailHref ?? detailsHref}
                state={appDetailState ?? undefined}
                className="block truncate text-sm font-semibold text-gray-900 transition-colors hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
              >
                {task.software.name}
              </Link>
              <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                {task.software.artistName}
              </p>
            </div>
            <div className="shrink-0 whitespace-nowrap">
              <Badge status={task.status} label={processingLabel} />
            </div>
          </div>
          <p
            title={task.software.bundleID}
            className="mt-1 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500"
          >
            {task.software.bundleID}
          </p>
        </div>
      </div>

      {/* The summary answers for the same four facts the package detail page
          shows: version (with its build id), release date, size, minimum OS. */}
      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryItem
          label={t('downloads.package.version')}
          value={versionLabel}
        />
        <SummaryItem
          label={t('downloads.package.released')}
          value={formatDateISO(task.software.releaseDate) ?? '—'}
        />
        <SummaryItem
          label={t('downloads.package.size')}
          value={formatBytes(task.software.fileSizeBytes)}
        />
        <SummaryItem
          label={t('downloads.package.minOs')}
          value={task.software.minimumOsVersion ? `${PLATFORM_LABELS[task.software.platform || 'ios']} ${task.software.minimumOsVersion}` : '—'}
        />
      </dl>

      {(isActive || isPaused) && (
        <div className="mt-3">
          <ProgressBar progress={task.progress} label={task.software.name} />
          <div className="mt-1.5 flex min-w-0 justify-between gap-3 text-xs font-medium text-gray-500 dark:text-gray-400">
            <span>{Math.round(task.progress)}%</span>
            {task.speed && isActive && (
              <span className="max-w-[55%] truncate text-right">
                {task.speed}
              </span>
            )}
          </div>
        </div>
      )}

      {task.error && (
        <p className="mt-3 break-words rounded-lg bg-red-50 p-2.5 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
          {task.error}
        </p>
      )}

      {task.status === 'completed' && task.hasFile && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <PackageQuickActions task={task} size="compact" />
        </div>
      )}

      <div
        className={`mt-3 grid min-w-0 gap-2 text-[15px] ${
          appDetailHref ? 'grid-cols-3' : 'grid-cols-2'
        }`}
      >
        {appDetailHref && (
          <Link
            to={appDetailHref}
            state={appDetailState}
            className="inline-flex min-h-10 min-w-0 items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-center text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('search.product.title')}
          </Link>
        )}
        {isActive ? (
          <button
            type="button"
            onClick={() => onPause(task.id)}
            disabled={!canPause}
            className={`min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors dark:border-gray-700 dark:text-gray-300 ${
              canPause
                ? 'hover:bg-gray-50 dark:hover:bg-gray-800'
                : 'cursor-not-allowed opacity-50'
            }`}
          >
            {t('downloads.package.pause')}
          </button>
        ) : isPaused ? (
          <button
            type="button"
            onClick={() => onResume(task.id)}
            className="min-h-10 min-w-0 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-950"
          >
            {t('downloads.package.resume')}
          </button>
        ) : isFailed && onRetry ? (
          // A failed download has no package to open, so this slot offers the
          // retry instead — the same app, build and account, asked for again.
          <button
            type="button"
            onClick={() => onRetry(task.id)}
            className="min-h-10 min-w-0 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-950"
          >
            {t('downloads.package.retry')}
          </button>
        ) : (
          <Link
            to={detailsHref}
            className="inline-flex min-h-10 min-w-0 items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-center text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('downloads.package.title')}
          </Link>
        )}
        <button
          type="button"
          onClick={() => onDelete(task.id)}
          className={dangerButtonClass('compact')}
        >
          {t('downloads.package.delete')}
        </button>
      </div>
    </article>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-gray-50 px-2.5 py-2 dark:bg-gray-800/60">
      <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </dt>
      <dd
        title={value}
        className="mt-0.5 truncate text-xs font-medium text-gray-700 dark:text-gray-200"
      >
        {value}
      </dd>
    </div>
  );
}
