import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppIcon from '../common/AppIcon';
import Badge from '../common/Badge';
import ProgressBar from '../common/ProgressBar';
import PackageQuickActions, { dangerButtonClass } from './PackageQuickActions';
import { isPreviewDownloadTask } from './previewTasks';
import { useAccounts } from '../../hooks/useAccounts';
import { accountStoreCountry, packageAccountLabel } from '../../utils/account';
import { formatDateISO, formatDateTimeISO } from '../../utils/software';
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
  /** Left out when the task's account is gone: a retry cannot work without one. */
  onRetry?: (id: string) => void;
  /**
   * Offered to a settled row: asks for this app's latest version and offers to
   * fetch it. Left out with the retry's reasoning — the owning account must ask.
   */
  onCheckUpdate?: (id: string) => void;
  /** True while this row's update check is in flight. */
  checkingUpdate?: boolean;
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
  onCheckUpdate,
  checkingUpdate = false,
}: DownloadItemProps) {
  const { t } = useTranslation();
  const { accounts } = useAccounts();

  const isActive = task.status === 'downloading' || task.status === 'injecting';
  const isPaused = task.status === 'paused';
  const isFailed = task.status === 'failed';
  // Pausing is the transfer's action: once the package is on disk an abort would
  // keep nothing, so the button is disabled rather than calling something that fails.
  const canPause = task.status === 'downloading';
  // The post-transfer phase differs by package: macOS is decrypted, an IPA is compiled.
  const processingLabel =
    task.status === 'injecting' && task.software.platform === 'macos'
      ? t('downloads.status.decrypting')
      : undefined;
  // The app's own detail page, carrying the platform, owning account (storefront
  // travels as `country`) and version id — so its 详细信息 answers for this package.
  // State rides the Link's `state` prop (object `to` drops it); no app id means no page.
  const owningAccount = accounts.find((a) => a.email === accountEmail);
  // A package belongs to the account it was downloaded with: a live account is
  // named as the account pickers name it, else the record's email/hash fallback is used.
  const accountFallback = isPreviewDownloadTask(task)
    ? t('downloads.preview.account')
    : accountEmail || task.accountHash;
  const accountLabel = packageAccountLabel(owningAccount, accountFallback, t);
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

  // The build id travels beside the version number, naming the one build this row is about.
  const versionLabel = task.software.externalVersionId
    ? `${task.software.version} (${task.software.externalVersionId})`
    : task.software.version;

  // The task's own action, in one slot: pause/resume, the retry a failed one
  // offers, or the update check a settled one offers. Left out when the account is
  // gone — a retry needs one and the check is that account's question to ask.
  let taskAction: ReactNode = null;
  if (isActive) {
    taskAction = (
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
    );
  } else if (isPaused) {
    taskAction = (
      <button
        type="button"
        onClick={() => onResume(task.id)}
        className="min-h-10 min-w-0 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-950"
      >
        {t('downloads.package.resume')}
      </button>
    );
  } else if (isFailed && onRetry) {
    // A failed download has no package to open, so this slot offers the retry instead.
    taskAction = (
      <button
        type="button"
        onClick={() => onRetry(task.id)}
        className="min-h-10 min-w-0 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-950"
      >
        {t('downloads.package.retry')}
      </button>
    );
  } else if (onCheckUpdate) {
    // What is left of a settled row: ask whether the app has moved on, offer the newer build.
    taskAction = (
      <button
        type="button"
        onClick={() => onCheckUpdate(task.id)}
        disabled={checkingUpdate}
        className="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {checkingUpdate
          ? t('downloads.package.checkingUpdate')
          : t('downloads.package.checkUpdate')}
      </button>
    );
  }

  // How many buttons the action row draws (app page, task action, delete) so the grid fills.
  const actionCount = (appDetailHref ? 1 : 0) + (taskAction ? 1 : 0) + 1;

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
        {appDetailHref ? (
          <Link
            to={appDetailHref}
            state={appDetailState ?? undefined}
            className="min-w-0 shrink-0"
          >
            <AppIcon
              url={taskIconUrl(task)}
              name={task.software.name}
              size="sm"
            />
          </Link>
        ) : (
          <div className="min-w-0 shrink-0">
            <AppIcon
              url={taskIconUrl(task)}
              name={task.software.name}
              size="sm"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {appDetailHref ? (
                <Link
                  to={appDetailHref}
                  state={appDetailState ?? undefined}
                  className="block truncate text-sm font-semibold text-gray-900 transition-colors hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                >
                  {task.software.name}
                </Link>
              ) : (
                <p className="block truncate text-sm font-semibold text-gray-900 dark:text-white">
                  {task.software.name}
                </p>
              )}
              <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                {task.software.artistName}
              </p>
            </div>
            <div className="shrink-0 whitespace-nowrap">
              <Badge status={task.status} label={processingLabel} />
            </div>
          </div>
        </div>
      </div>

      {/* Same facts and order as the package detail page: the app and what it takes
          to run it (App ID, Bundle ID, min OS, size), then the build (version, release date). */}
      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        <SummaryItem
          label={t('downloads.package.appId')}
          value={String(task.software.id)}
          mono
        />
        <SummaryItem
          label={t('downloads.package.bundleId')}
          value={task.software.bundleID || '—'}
          mono
        />
        <SummaryItem
          label={t('downloads.package.minOs')}
          value={task.software.minimumOsVersion ? `${PLATFORM_LABELS[task.software.platform || 'ios']} ${task.software.minimumOsVersion}` : '—'}
        />
        <SummaryItem
          label={t('downloads.package.size')}
          value={formatBytes(task.software.fileSizeBytes)}
        />
        <SummaryItem
          label={t('downloads.package.version')}
          value={versionLabel}
        />
        <SummaryItem
          label={t('downloads.package.released')}
          value={formatDateISO(task.software.releaseDate) ?? '—'}
        />
      </dl>

      {/* Whose package this is and when it arrived — the facts that tell two downloads
          of one build apart, now each account keeps its own. Stacks on a phone. */}
      <dl className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <SummaryItem
          label={t('downloads.package.account')}
          value={accountLabel}
        />
        <SummaryItem
          label={t('downloads.package.downloadedAt')}
          value={formatDateTimeISO(task.createdAt) ?? '—'}
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

      {task.status === 'completed' && !task.hasFile && (
        // Packages are temporary — a server restart clears them — so a finished row
        // whose file is gone must say so rather than look ready to install.
        <p className="mt-3 rounded-lg bg-amber-50 p-2.5 text-xs font-medium text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {t('downloads.package.fileUnavailable')}
        </p>
      )}

      {task.status === 'completed' && task.hasFile && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <PackageQuickActions task={task} size="compact" />
        </div>
      )}

      <div
        className={`mt-3 grid min-w-0 gap-2 text-[15px] ${
          actionCount === 3
            ? 'grid-cols-3'
            : actionCount === 2
              ? 'grid-cols-2'
              : 'grid-cols-1'
        }`}
      >
        {/* The row's own action leads, the app's page follows, the destructive one last. */}
        {taskAction}
        {appDetailHref && (
          <Link
            to={appDetailHref}
            state={appDetailState}
            className="inline-flex min-h-10 min-w-0 items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-center text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('search.product.title')}
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

function SummaryItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-gray-50 px-2.5 py-2 dark:bg-gray-800/60">
      {/* The label keeps the copy's own case: the tiles name App ID and Bundle ID, not shouted. */}
      <dt className="truncate text-[10px] font-medium tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </dt>
      <dd
        title={value}
        className={`mt-0.5 truncate text-xs font-medium text-gray-700 dark:text-gray-200 ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
