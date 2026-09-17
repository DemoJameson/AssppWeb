import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackageQuickActions from '../../src/components/Download/PackageQuickActions';
import { previewDownloadTasks } from '../../src/components/Download/previewTasks';
import { useToastStore } from '../../src/store/toast';
import type { DownloadTask } from '../../src/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
);
const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');

function createTask(
  overrides: Partial<DownloadTask> = {},
): DownloadTask {
  return {
    id: 'real-download-task',
    software: {
      id: 123,
      bundleID: 'com.example.utility',
      name: 'Utility/App',
      version: '3.4.5',
      artistName: 'Example Developer',
      sellerName: 'Example Developer LLC',
      description: 'A test application.',
      averageUserRating: 4.8,
      userRatingCount: 42,
      artworkUrl: '',
      screenshotUrls: [],
      minimumOsVersion: '16.0',
      fileSizeBytes: '5242880',
      releaseDate: '2026-08-01T00:00:00Z',
      primaryGenreName: 'Utilities',
    },
    accountHash: 'account-hash-123',
    status: 'completed',
    progress: 100,
    speed: '',
    hasFile: true,
    createdAt: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor?: PropertyDescriptor,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  Reflect.deleteProperty(target, key);
}

describe('PackageQuickActions', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    restoreProperty(navigator, 'clipboard', originalClipboard);
    restoreProperty(navigator, 'share', originalShare);
    useToastStore.setState({ toasts: [] });
  });

  it('shows install, share, and download for a completed package with a file', () => {
    render(<PackageQuickActions task={createTask()} />);

    expect(screen.getByTestId('package-quick-actions')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    ).toHaveAttribute('href', expect.stringMatching(/^itms-services:\/\//));
    expect(
      screen.getByRole('button', { name: 'downloads.package.share' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'downloads.package.downloadIpa' }),
    ).toBeInTheDocument();
  });

  it('does not show quick actions when a completed task has no file', () => {
    render(
      <PackageQuickActions task={createTask({ hasFile: false })} />,
    );

    expect(screen.queryByTestId('package-quick-actions')).not.toBeInTheDocument();
  });

  it.each<DownloadTask['status']>([
    'pending',
    'downloading',
    'paused',
    'injecting',
    'failed',
  ])('does not show quick actions for a %s task', (status) => {
    render(<PackageQuickActions task={createTask({ status })} />);

    expect(screen.queryByTestId('package-quick-actions')).not.toBeInTheDocument();
  });

  it('keeps all preview actions local and shows a notice for each click', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const nativeShare = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: nativeShare,
    });

    render(<PackageQuickActions task={previewDownloadTasks[0]} />);

    await user.click(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'downloads.package.share' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'downloads.package.downloadIpa' }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(nativeShare).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(3);
    expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'downloads.preview.actionHint',
          title: 'downloads.preview.badge',
          type: 'info',
        }),
      ]),
    );
  });

  it('hands a real package to the browser as a native download', async () => {
    const user = userEvent.setup();
    const downloadUrl =
      '/api/packages/real-download-task/file?accountHash=account-hash-123&exp=123&sig=abc';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: downloadUrl }),
    } as Response);
    let clickedAnchor: HTMLAnchorElement | undefined;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function captureAnchor(this: HTMLAnchorElement) {
        clickedAnchor = this;
      });
    sessionStorage.setItem('auth-token', 'test-access-token');

    render(<PackageQuickActions task={createTask()} />);
    await user.click(
      screen.getByRole('button', { name: 'downloads.package.downloadIpa' }),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/packages/real-download-task/file-url?accountHash=account-hash-123',
        { headers: { 'X-Access-Token': 'test-access-token' } },
      );
      expect(anchorClick).toHaveBeenCalledOnce();
    });
    expect(clickedAnchor?.getAttribute('href')).toBe(downloadUrl);
    expect(clickedAnchor?.download).toBe('Utility-App_3.4.5.ipa');
  });

  it('surfaces a toast when the download URL cannot be issued', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('nope'),
    } as Response);
    sessionStorage.setItem('auth-token', 'test-access-token');

    render(<PackageQuickActions task={createTask()} />);
    await user.click(
      screen.getByRole('button', { name: 'downloads.package.downloadIpa' }),
    );

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'downloads.package.downloadFailed',
          }),
        ]),
      );
    });
  });
});
