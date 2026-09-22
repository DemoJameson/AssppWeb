import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DownloadItem from '../../src/components/Download/DownloadItem';
import { useAccountsStore } from '../../src/store/accounts';
import type { Account, DownloadTask } from '../../src/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function createTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-id',
    software: {
      id: 6503940939,
      bundleID: 'flux.inchmade.app',
      name: 'Forward',
      version: '1.3.18',
      artistName: '',
      sellerName: '',
      description: '',
      averageUserRating: 0,
      userRatingCount: 0,
      artworkUrl: '',
      screenshotUrls: [],
      minimumOsVersion: '17.0',
      releaseDate: '',
      primaryGenreName: '',
    },
    accountHash: 'account-hash-123',
    status: 'completed',
    progress: 100,
    speed: '0 B/s',
    hasFile: false,
    createdAt: '2026-09-16T04:22:27.355Z',
    ...overrides,
  };
}

function renderItem(
  task: DownloadTask,
  props: Partial<{ onRetry: (id: string) => void }> = {},
) {
  return render(
    <MemoryRouter>
      <DownloadItem
        task={task}
        onPause={() => {}}
        onResume={() => {}}
        onDelete={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('DownloadItem icon', () => {
  afterEach(cleanup);

  it('draws the icon the package carried when the storefront had none', () => {
    // A by-ID download knows only the app id, so the package is the only
    // source for an icon.
    const { container } = renderItem(createTask({ hasIcon: true }));

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/api/downloads/task-id/icon?accountHash=account-hash-123',
    );
  });

  it('prefers the storefront artwork', () => {
    const { container } = renderItem(
      createTask({
        hasIcon: true,
        software: {
          ...createTask().software,
          artworkUrl: 'https://cdn.apple.com/art.png',
        },
      }),
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.apple.com/art.png',
    );
  });

  it('falls back to the initial when no icon exists at all', () => {
    const { container } = renderItem(createTask());

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('F');
  });
});

function StateProbe() {
  const location = useLocation();
  return (
    <div data-testid="probe">{JSON.stringify(location.state ?? null)}</div>
  );
}

describe('DownloadItem app-detail link', () => {
  afterEach(cleanup);

  it('leads the second action row with a link carrying the platform', () => {
    const task = createTask({
      software: { ...createTask().software, platform: 'tvos' },
    });
    const { container, getByRole, getAllByRole } = renderItem(task);

    const link = getByRole('link', { name: 'search.product.title' });
    expect(link).toHaveAttribute(
      'href',
      '/search/6503940939?platform=tvos',
    );

    const secondRow = container.querySelector('div.grid.grid-cols-3');
    expect(secondRow?.firstElementChild).toBe(link);

    // The icon and the name lead to the app, not the package.
    const headerLinks = getAllByRole('link', { name: 'Forward' });
    expect(headerLinks).toHaveLength(2);
    for (const headerLink of headerLinks) {
      expect(headerLink).toHaveAttribute(
        'href',
        '/search/6503940939?platform=tvos',
      );
    }
  });

  it('defaults the platform to ios when the task names none', () => {
    const { getByRole } = renderItem(createTask());

    expect(getByRole('link', { name: 'search.product.title' })).toHaveAttribute(
      'href',
      '/search/6503940939?platform=ios',
    );
  });

  it('carries the owning account in the navigation state', () => {
    const owner: Account = {
      email: 'owner-cn@example.test',
      password: 'x',
      appleId: 'owner-cn@example.test',
      store: '143465',
      firstName: 'Owner',
      lastName: 'Cn',
      passwordToken: 't',
      directoryServicesIdentifier: 'dsid-owner',
      cookies: [],
      deviceIdentifier: 'aabbccddeeff',
    };
    const previous = useAccountsStore.getState().accounts;
    useAccountsStore.setState({ accounts: [owner] });

    render(
      <MemoryRouter initialEntries={['/downloads/task-id']}>
        <Routes>
          <Route
            path="/downloads/:id"
            element={
              <DownloadItem
                task={createTask()}
                accountEmail={owner.email}
                onPause={() => {}}
                onResume={() => {}}
                onDelete={() => {}}
              />
            }
          />
          <Route path="/search/:appId" element={<StateProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(useAccountsStore.getState().accounts.map((a) => a.email)).toEqual([
      owner.email,
    ]);
    fireEvent.click(screen.getByRole('link', { name: 'search.product.title' }));

    expect(screen.getByTestId('probe').textContent).toBe(
      JSON.stringify({ accountEmail: owner.email, country: 'CN' }),
    );
    useAccountsStore.setState({ accounts: previous });
  });

  it('carries the package build even when no account owns it', () => {
    // The build the link names is what the detail page opens on — its own
    // numbers, and 已下载 — so it must travel on its own account or not.
    const task = createTask({
      software: { ...createTask().software, externalVersionId: '888154623' },
    });

    render(
      <MemoryRouter initialEntries={['/downloads/task-id']}>
        <Routes>
          <Route
            path="/downloads/:id"
            element={
              <DownloadItem
                task={task}
                onPause={() => {}}
                onResume={() => {}}
                onDelete={() => {}}
              />
            }
          />
          <Route path="/search/:appId" element={<StateProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'search.product.title' }));

    expect(screen.getByTestId('probe').textContent).toBe(
      JSON.stringify({ versionId: '888154623' }),
    );
  });
});
describe('DownloadItem retry', () => {
  afterEach(cleanup);

  it('offers the retry in place of the package link when the download failed', () => {
    // The package link would open a page about a file that never finished
    // arriving, so that slot is where the retry belongs.
    const onRetry = vi.fn();
    renderItem(createTask({ status: 'failed', error: 'Download timed out' }), {
      onRetry,
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'downloads.package.retry' }),
    );

    expect(onRetry).toHaveBeenCalledWith('task-id');
    expect(
      screen.queryByRole('link', { name: 'downloads.package.title' }),
    ).toBeNull();
  });

  it('leaves the package link when the failed download has no account left', () => {
    // Without its account there is nothing to retry with, so the row keeps what
    // it can still offer instead of a button that would do nothing.
    renderItem(createTask({ status: 'failed', error: 'Download timed out' }));

    expect(
      screen.queryByRole('button', { name: 'downloads.package.retry' }),
    ).toBeNull();
    expect(
      screen.getByRole('link', { name: 'downloads.package.title' }),
    ).toBeTruthy();
  });

  it('offers no retry while the download is still running', () => {
    const onRetry = vi.fn();
    renderItem(createTask({ status: 'downloading', progress: 42 }), {
      onRetry,
    });

    expect(
      screen.queryByRole('button', { name: 'downloads.package.retry' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'downloads.package.pause' }),
    ).toBeTruthy();
  });
});

describe('DownloadItem processing badge', () => {
  afterEach(cleanup);

  it('says a macOS package is being decrypted, not injected', () => {
    // The phase after the transfer is decryption for a Mac package, and the
    // row is at the download's 100% while it runs: the badge is what says the
    // task is still working rather than stuck.
    renderItem(
      createTask({
        status: 'injecting',
        progress: 40,
        software: { ...createTask().software, platform: 'macos' },
      }),
    );

    expect(screen.getByText('downloads.status.decrypting')).toBeTruthy();
    expect(screen.queryByText('downloads.status.injecting')).toBeNull();
  });

  it('keeps the injected wording for a package that is compiled', () => {
    renderItem(
      createTask({
        status: 'injecting',
        software: { ...createTask().software, platform: 'ios' },
      }),
    );

    expect(screen.getByText('downloads.status.injecting')).toBeTruthy();
    expect(screen.queryByText('downloads.status.decrypting')).toBeNull();
  });

  it('does not offer to pause a package the server is working on', () => {
    // The transfer is over, so there is nothing to pause: the button is off
    // rather than a call the server would refuse.
    renderItem(
      createTask({
        status: 'injecting',
        progress: 62,
        software: { ...createTask().software, platform: 'macos' },
      }),
    );

    expect(
      screen.getByRole('button', { name: 'downloads.package.pause' }),
    ).toHaveProperty('disabled', true);
  });
});
