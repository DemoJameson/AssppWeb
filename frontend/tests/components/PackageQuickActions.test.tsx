import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackageQuickActions from '../../src/components/Download/PackageQuickActions';
import { previewDownloadTasks } from '../../src/components/Download/previewTasks';
import { useToastStore } from '../../src/store/toast';
import { detectInstallDevice, isAppleSiliconMac } from '../../src/utils/device';
import { openInstallUrl } from '../../src/api/install';
import type { DownloadTask } from '../../src/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// The install guard asks these two; the decision logic itself stays real.
vi.mock('../../src/utils/device', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/device')>();
  return {
    ...actual,
    detectInstallDevice: vi.fn(() => ({ family: 'iphone', name: 'iPhone' })),
    isAppleSiliconMac: vi.fn(async () => false),
  };
});

vi.mock('../../src/api/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/install')>();
  return { ...actual, openInstallUrl: vi.fn() };
});

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
    vi.mocked(detectInstallDevice).mockReturnValue({
      family: 'iphone',
      name: 'iPhone',
    });
    vi.mocked(isAppleSiliconMac).mockResolvedValue(false);
    vi.mocked(openInstallUrl).mockClear();
    vi.mocked(openInstallUrl).mockImplementation(() => {});
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
      screen.getByRole('link', { name: 'downloads.package.downloadIpa' }),
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
      screen.getByRole('link', { name: 'downloads.package.downloadIpa' }),
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

  it('prefetches the download URL on hover so the link carries it for IDM interception', async () => {
    const user = userEvent.setup();
    const downloadUrl =
      '/api/packages/real-download-task/file?accountHash=account-hash-123&exp=123&sig=abc';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: downloadUrl }),
    } as Response);
    sessionStorage.setItem('auth-token', 'test-access-token');

    render(<PackageQuickActions task={createTask()} />);

    const link = screen.getByRole('link', { name: 'downloads.package.downloadIpa' });
    await user.hover(link);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/packages/real-download-task/file-url?accountHash=account-hash-123',
        { headers: { 'X-Access-Token': 'test-access-token' } },
      );
    });
    await waitFor(() => {
      expect(link).toHaveAttribute(
        'href',
        new URL(downloadUrl, 'http://localhost:8080').href,
      );
    });
    expect(link).toHaveAttribute('download', 'Utility-App_3.4.5.ipa');
  });

  it('refetches when the prefetched link has expired', async () => {
    const user = userEvent.setup();
    const expiredUrl =
      '/api/packages/real-download-task/file?accountHash=account-hash-123&exp=1&sig=abc';
    const freshUrl =
      '/api/packages/real-download-task/file?accountHash=account-hash-123&exp=9999999999999&sig=def';
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ url: callCount === 1 ? expiredUrl : freshUrl }),
      } as Response);
    });
    sessionStorage.setItem('auth-token', 'test-access-token');

    render(<PackageQuickActions task={createTask()} />);

    const link = screen.getByRole('link', { name: 'downloads.package.downloadIpa' });
    await user.hover(link);
    await waitFor(() => {
      expect(link).toHaveAttribute(
        'href',
        new URL(expiredUrl, 'http://localhost:8080').href,
      );
    });

    await user.click(link);
    await waitFor(() => {
      expect(callCount).toBe(2);
    });
    expect(useToastStore.getState().toasts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'downloads.package.downloadFailed',
        }),
      ]),
    );
  });

  it('fetches the download URL on click without a prior hover', async () => {
    const downloadUrl =
      '/api/packages/real-download-task/file?accountHash=account-hash-123&exp=123&sig=abc';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: downloadUrl }),
    } as Response);
    sessionStorage.setItem('auth-token', 'test-access-token');

    render(<PackageQuickActions task={createTask()} />);
    fireEvent.click(
      screen.getByRole('link', { name: 'downloads.package.downloadIpa' }),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/packages/real-download-task/file-url?accountHash=account-hash-123',
        { headers: { 'X-Access-Token': 'test-access-token' } },
      );
    });
    await waitFor(() => {
      expect(useToastStore.getState().toasts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'downloads.package.downloadFailed',
          }),
        ]),
      );
    });
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
      screen.getByRole('link', { name: 'downloads.package.downloadIpa' }),
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

  it('blocks a package the device cannot take, and does not navigate', async () => {
    const task = createTask();
    render(
      <PackageQuickActions
        task={{
          ...task,
          software: { ...task.software, platform: 'visionos' },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    );

    expect(
      await screen.findByText('install.blocked.title'),
    ).toBeInTheDocument();
    expect(screen.getByText('install.blocked.body')).toBeInTheDocument();
    expect(
      screen.getByText('install.blocked.hintVisionPro'),
    ).toBeInTheDocument();
    expect(openInstallUrl).not.toHaveBeenCalled();
  });

  it('confirms with the overwrite notice before installing', async () => {
    render(<PackageQuickActions task={createTask()} />);

    fireEvent.click(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    );

    expect(
      await screen.findByText('install.overwrite.title'),
    ).toBeInTheDocument();
    expect(screen.getByText('install.overwrite.body')).toBeInTheDocument();
    expect(openInstallUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('install.continue'));

    expect(openInstallUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^itms-services:\/\//),
    );
    await waitFor(() =>
      expect(screen.queryByText('install.overwrite.title')).toBeNull(),
    );
  });

  it('cancels out of the overwrite notice without navigating', async () => {
    render(<PackageQuickActions task={createTask()} />);

    fireEvent.click(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    );
    expect(
      await screen.findByText('install.overwrite.title'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('settings.data.cancel'));

    await waitFor(() =>
      expect(screen.queryByText('install.overwrite.title')).toBeNull(),
    );
    expect(openInstallUrl).not.toHaveBeenCalled();
  });

  it('lets a confirmed Apple-silicon Mac take an iOS package', async () => {
    vi.mocked(detectInstallDevice).mockReturnValue({
      family: 'mac',
      name: 'Mac',
    });
    vi.mocked(isAppleSiliconMac).mockResolvedValue(true);
    render(<PackageQuickActions task={createTask()} />);

    fireEvent.click(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    );

    expect(
      await screen.findByText('install.overwrite.title'),
    ).toBeInTheDocument();
    expect(screen.getByText('install.overwrite.bodyMac')).toBeInTheDocument();
    expect(screen.queryByText('install.overwrite.body')).toBeNull();
    expect(isAppleSiliconMac).toHaveBeenCalled();
  });

  it('sends an unconfirmed Mac to the download route', async () => {
    vi.mocked(detectInstallDevice).mockReturnValue({
      family: 'mac',
      name: 'Mac',
    });
    vi.mocked(isAppleSiliconMac).mockResolvedValue(false);
    render(<PackageQuickActions task={createTask()} />);

    fireEvent.click(
      screen.getByRole('link', { name: 'downloads.package.install' }),
    );

    expect(
      await screen.findByText('install.blocked.title'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('install.blocked.hintDownload'),
    ).toBeInTheDocument();
    expect(openInstallUrl).not.toHaveBeenCalled();
  });
});
