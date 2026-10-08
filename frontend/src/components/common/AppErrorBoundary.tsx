import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isChunkLoadFailure } from '../../utils/chunkLoadFailure';

interface Props {
  children: ReactNode;
  /**
   * `page` fills the viewport (used at the root); `inline` fills the parent so
   * the surrounding layout stays usable around the routes.
   */
  variant?: 'page' | 'inline';
}

interface State {
  error: Error | null;
}

/**
 * Keeps a failed render from becoming a blank page. A chunk-load failure is
 * memoized by `React.lazy`, so only a reload recovers it; a render error may
 * be transient, so retry is offered too.
 */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[asspp] render failed', error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Fallback
        variant={this.props.variant ?? 'page'}
        // A memoized rejection makes "try again" useless, so retry is withheld.
        recoverable={!isChunkLoadFailure(error)}
        onRetry={this.retry}
        onReload={this.reload}
      />
    );
  }
}

function Fallback({
  variant,
  recoverable,
  onRetry,
  onReload,
}: {
  variant: 'page' | 'inline';
  recoverable: boolean;
  onRetry: () => void;
  onReload: () => void;
}) {
  // Safe to translate here: i18n is a static import in main.tsx (part of the
  // entry bundle), so only the lazily-loaded route chunks are at risk.
  const { t } = useTranslation();
  const sizing = variant === 'page' ? 'min-h-[100dvh]' : 'min-h-full';

  return (
    <div
      className={`flex ${sizing} items-center justify-center bg-gray-50 px-6 py-10 text-gray-900 dark:bg-gray-950 dark:text-gray-100`}
      role="alert"
    >
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-7 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h1 className="text-lg font-semibold">{t('errors.ui.loadFailed')}</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
          {t('errors.ui.loadFailedHint')}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {recoverable && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              {t('errors.ui.tryAgain')}
            </button>
          )}
          <button
            type="button"
            onClick={onReload}
            className={
              recoverable
                ? 'rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
                : 'rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900'
            }
          >
            {t('errors.ui.reloadPage')}
          </button>
        </div>
      </div>
    </div>
  );
}
