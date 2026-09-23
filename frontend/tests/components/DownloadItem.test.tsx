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

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
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
    ...overrides,
  };
}

function renderItem(
  task: DownloadTask,
  props: Partial<{
    onRetry: (id: string) => void;
    onCheckUpdate: (id: string) => void;
    checkingUpdate: boolean;
    accountEmail: string;
  }> = {},
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

  it('keeps the app link in the action row, after the row’s own action', () => {
    const task = createTask({
      software: { ...createTask().software, platform: 'tvos' },
    });
    const { container, getByRole, getAllByRole } = renderItem(task, {
      onCheckUpdate: vi.fn(),
    });

    const link = getByRole('link', { name: 'search.product.title' });
    expect(link).toHaveAttribute(
      'href',
      '/search/6503940939?platform=tvos',
    );

    // The row's own action leads, the app's page follows it, delete stays last.
    const actionRow = container.querySelector('div.grid.grid-cols-3');
    expect(
      Array.from(actionRow?.children ?? []).map((child) => child.textContent),
    ).toEqual([
      'downloads.package.checkUpdate',
      'search.product.title',
      'downloads.package.delete',
    ]);

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
    const owner = createAccount();
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

  it('offers the retry rather than the update check when the download failed', () => {
    // A failed download holds no package to compare against the storefront, so
    // the slot asks for the same build again instead of looking for a newer one.
    const onRetry = vi.fn();
    const { container } = renderItem(
      createTask({ status: 'failed', error: 'Download timed out' }),
      { onRetry, onCheckUpdate: vi.fn() },
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'downloads.package.retry' }),
    );

    expect(onRetry).toHaveBeenCalledWith('task-id');
    expect(
      screen.queryByRole('button', { name: 'downloads.package.checkUpdate' }),
    ).toBeNull();
    // Whatever the row offers leads its action row in any state.
    expect(container.querySelector('div.grid')?.firstElementChild?.textContent).toBe(
      'downloads.package.retry',
    );
  });

  it('leaves the slot empty when the failed download has no account left', () => {
    // Without its account there is nothing to retry with, so the row draws only
    // the two buttons that can still work rather than one that would do nothing.
    const { container } = renderItem(
      createTask({ status: 'failed', error: 'Download timed out' }),
    );

    expect(
      screen.queryByRole('button', { name: 'downloads.package.retry' }),
    ).toBeNull();
    expect(container.querySelector('div.grid')?.className).toContain(
      'grid-cols-2',
    );
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

describe('DownloadItem update check', () => {
  afterEach(cleanup);

  it('offers it once the download is done, and hands back the row', () => {
    const onCheckUpdate = vi.fn();
    renderItem(createTask(), { onCheckUpdate });

    fireEvent.click(
      screen.getByRole('button', { name: 'downloads.package.checkUpdate' }),
    );

    expect(onCheckUpdate).toHaveBeenCalledWith('task-id');
  });

  it('says the check is running, and refuses a second one', () => {
    renderItem(createTask(), { onCheckUpdate: vi.fn(), checkingUpdate: true });

    const button = screen.getByRole('button', {
      name: 'downloads.package.checkingUpdate',
    });
    expect(button).toHaveProperty('disabled', true);
  });

  it('leaves the slot out when there is no account to ask with', () => {
    // The check is the owning account's question; without it the row draws the
    // app link and delete only.
    const { container } = renderItem(createTask());
    const actions = container.querySelector('div.grid');

    expect(
      screen.queryByRole('button', { name: 'downloads.package.checkUpdate' }),
    ).toBeNull();
    expect(actions?.className).toContain('grid-cols-2');
  });
});

describe('DownloadItem missing package', () => {
  afterEach(cleanup);

  it('says a finished package is gone rather than looking installable', () => {
    // Packages are temporary, so a finished row can outlive its file; it has to
    // say so instead of leaving the user with install buttons that fail.
    renderItem(createTask({ status: 'completed', hasFile: false }));

    expect(screen.getByText('downloads.package.fileUnavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'downloads.package.install' }))
      .toBeNull();
  });
});

describe('DownloadItem information tiles', () => {
  afterEach(() => {
    cleanup();
    useAccountsStore.setState({ accounts: [] });
  });

  /** The row's facts, keyed by their label — the tiles it is drawn from. */
  function tiles(container: HTMLElement): Record<string, string> {
    return Object.fromEntries(
      Array.from(container.querySelectorAll('dt')).map((dt) => [
        dt.textContent ?? '',
        dt.nextElementSibling?.textContent ?? '',
      ]),
    );
  }

  it('names the build first and closes with whose download it is', () => {
    // What the app is and what it takes to run it (App ID, Bundle ID, minimum
    // OS, size), then the build itself (version with its id, release date),
    // then the two facts that tell two downloads of one build apart — whose it
    // is, and when it arrived.
    const { container } = renderItem(createTask());

    expect(Object.keys(tiles(container))).toEqual([
      'downloads.package.appId',
      'downloads.package.bundleId',
      'downloads.package.minOs',
      'downloads.package.size',
      'downloads.package.version',
      'downloads.package.released',
      'downloads.package.account',
      'downloads.package.downloadedAt',
    ]);
  });

  it('names the account the way the account pickers do', () => {
    const owner = createAccount();
    useAccountsStore.setState({ accounts: [owner] });

    const { container } = renderItem(createTask(), {
      accountEmail: owner.email,
    });

    // Storefront first, then the name and the address: the picker's own label,
    // not the bare email the record carries.
    expect(tiles(container)['downloads.package.account']).toBe(
      'countries.CN · Owner Cn (owner-cn@example.test)',
    );
  });

  it('falls back to what the record carries when its account is gone', () => {
    // A package outlives the account it was downloaded with; the row says the
    // address it is filed under rather than leaving the fact out.
    const { container } = renderItem(createTask(), {
      accountEmail: 'deleted@example.test',
    });

    expect(tiles(container)['downloads.package.account']).toBe(
      'deleted@example.test',
    );
  });

  it('says when the package arrived, in local time', () => {
    const { container } = renderItem(createTask());

    // The record carries UTC; the row prints the reader's own clock in one
    // stable shape, like the package detail page does.
    expect(tiles(container)['downloads.package.downloadedAt']).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('leaves the header to the app, and states the identifiers below', () => {
    // The bundle id used to have a line of its own under the name, with the
    // account under it; both are tiles now, stated once, among the facts.
    const owner = createAccount();
    useAccountsStore.setState({ accounts: [owner] });

    const { container } = renderItem(createTask(), {
      accountEmail: owner.email,
    });

    expect(container.querySelector('p.font-mono')).toBeNull();
    expect(tiles(container)['downloads.package.bundleId']).toBe(
      'flux.inchmade.app',
    );
    expect(tiles(container)['downloads.package.appId']).toBe('6503940939');
    expect(
      (container.textContent?.match(/downloads\.package\.account/g) ?? [])
        .length,
    ).toBe(1);
  });

  it('says so when the bundle id is one the record does not carry', () => {
    // A by-ID download of an app nothing has named yet: the grid keeps its
    // shape and marks the identifier unknown, as it does for a date.
    const { container } = renderItem(
      createTask({
        software: { ...createTask().software, bundleID: '' },
      }),
    );

    expect(tiles(container)['downloads.package.bundleId']).toBe('—');
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
