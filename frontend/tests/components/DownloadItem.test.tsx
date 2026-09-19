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

function renderItem(task: DownloadTask) {
  return render(
    <MemoryRouter>
      <DownloadItem
        task={task}
        onPause={() => {}}
        onResume={() => {}}
        onDelete={() => {}}
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
});
