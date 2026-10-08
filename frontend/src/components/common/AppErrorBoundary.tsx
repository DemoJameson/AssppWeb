import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isChunkLoadFailure } from '../../utils/chunkLoadFailure';

interface Props {
  children: ReactNode;
  /**
   * `page` fills the viewport (used at the root, where there is no layout left
   * to preserve); `inline` fills the parent (used around the routes, so the
   * sidebar and tabs stay usable and the user can navigate away from the tab
   * that failed).
   */
  variant?: 'page' | 'inline';
}

interface State {
  error: Error | null;
}

/**
 * Keeps a failed render from becoming a blank page.
 *
 * React unmounts the entire tree when an error reaches the root, so without a
 * boundary anywhere above the routes any escaping error — a chunk that failed
 * to load, a render throw — leaves `<div id="root">` empty and the user staring
 * at white with nothing to click. This catches it and offers the action that
 * can actually recover.
 *
 * Note the asymmetry between the two buttons, which is deliberate: a rejected
 * dynamic import is memoized by `React.lazy`, so re-rendering the same
 * component rejects again without touching the network. For that failure the
 * only thing that works is a reload, and offering "try again" would be a lie.
 * A render error, by contrast, may well be transient state that re-rendering
 * clears. So chunk failures get the reload alone.
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
        // A memoized rejection means "try again" cannot help; a reload is the
        // only move, so the retry button is withheld rather than shown inert.
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
  // Safe to translate here even though this component only renders on a
  // failure: i18n is a static import in main.tsx, so it is part of the entry
  // bundle and is always loaded by the time anything can throw. Only the
  // lazily-loaded route chunks are at risk.
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
