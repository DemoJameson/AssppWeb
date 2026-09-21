import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SearchPage from '../../src/components/Search/SearchPage';
import {
  DownloadError,
  MissingAppError,
  PlatformVersionUnavailableError,
} from '../../src/apple/errors';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { lookupAppById, searchApps } from '../../src/api/search';
import { useSearch } from '../../src/hooks/useSearch';
import { useToastStore } from '../../src/store/toast';
import { useVersionListsStore } from '../../src/store/versionLists';
import { useVersionMetadataStore } from '../../src/store/versionMetadata';
import { bareSoftwareById } from '../../src/utils/software';
import type { Account } from '../../src/types';

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  listVersions: vi.fn(),
}));

vi.mock('../../src/api/search', () => ({
  searchApps: vi.fn(),
  lookupApp: vi.fn(),
  lookupAppById: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The real i18n module initialises (pulled in via apple/download through the
  // metadata hook), so the plugin slot has to exist.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// The metadata hook's accurate-date path imports the pinned download exchange;
// keep its libcurl transport out of the jsdom graph.
vi.mock('../../src/apple/request', () => ({
  appleRequest: vi.fn(),
}));
vi.mock('../../src/apple/bag', () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
}));

vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({ accounts: mocks.accounts }),
}));

vi.mock('../../src/hooks/useDownloadAction', () => ({
  useDownloadAction: () => ({ listVersionsWithLicense: mocks.listVersions }),
}));

// The newest version's label is looked up live; the module is stubbed so the
// libcurl-backed exchange never enters the import graph.
vi.mock('../../src/apple/versionLookup', () => ({
  getVersionMetadata: vi.fn(),
}));

const account: Account = {
  email: 'developer@example.test',
  password: 'test-password',
  appleId: 'developer@example.test',
  store: '143441',
  firstName: 'Example',
  lastName: 'Developer',
  passwordToken: 'test-token',
  directoryServicesIdentifier: '123456789',
  cookies: [],
  deviceIdentifier: '001122aabbcc',
};

/** The bare App ID a missed lookup leaves behind. */
const bare = bareSoftwareById('6503940939', 'ios');

/**
 * A package-index record as the backend builds one for a platform it has no
 * build for: the app is known, `version` is empty because only some *other*
 * platform was ever downloaded here.
 */
const localRecord = {
  ...bareSoftwareById('6503940939', 'ios'),
  name: 'Forward',
  bundleID: 'flux.inchmade.app',
  artistName: '宋帅 郑',
  primaryGenreName: 'Entertainment',
  metadataSource: 'local' as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSearchPage() {
  // The path matters: PageContainer clears the search state off /search.
  return render(
    <MemoryRouter initialEntries={['/search']}>
      <SearchPage />
    </MemoryRouter>,
  );
}

describe('SearchPage App ID probe', () => {
  beforeEach(() => {
    mocks.accounts = [account];
    mocks.listVersions.mockReset();
    mocks.listVersions.mockResolvedValue({ versions: [], updatedCookies: [] });
    vi.mocked(searchApps).mockReset();
    vi.mocked(searchApps).mockResolvedValue([]);
    vi.mocked(lookupAppById).mockReset();
    vi.mocked(lookupAppById).mockResolvedValue(null);
    vi.mocked(getVersionMetadata).mockReset();
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: '9.9.9', releaseDate: '2026-01-01T00:00:00Z' },
      updatedCookies: [],
    } as never);
    useVersionListsStore.setState({ lists: {} });
    useVersionMetadataStore.setState({
      entries: {},
      pending: {},
      attempted: {},
    });
    useToastStore.setState({ toasts: [] });
    useSearch.setState({
      term: bare.name,
      country: 'US',
      platform: 'ios',
      results: [bare],
      loading: false,
      error: null,
      searched: true,
    });
  });

  it('opens on iOS and a region the account can act in', async () => {
    useSearch.setState({ country: '', platform: '' });
    // The account answers from JP, so that is where the page opens.
    mocks.accounts = [{ ...account, store: '143462' }];

    renderSearchPage();

    await waitFor(() => expect(useSearch.getState().country).toBe('JP'));
    expect(useSearch.getState().platform).toBe('ios');
  });

  it('falls back to China when the instance has no account', async () => {
    useSearch.setState({ country: '', platform: '' });
    mocks.accounts = [];

    renderSearchPage();

    await waitFor(() => expect(useSearch.getState().country).toBe('CN'));
    expect(useSearch.getState().platform).toBe('ios');
  });

  it('keeps the region and platform picked last time', async () => {
    useSearch.setState({ country: 'GB', platform: 'ipad' });

    renderSearchPage();
    await act(async () => {
      await Promise.resolve();
    });

    // A stored pair is the user's own choice: an account's storefront does
    // not take it over.
    expect(useSearch.getState().country).toBe('GB');
    expect(useSearch.getState().platform).toBe('ipad');
  });

  it('does not search when dimensions change before the first search', async () => {
    // A term typed but never searched is not a query: switching the platform
    // must not fire a search for it — the 搜索 button is what starts one.
    useSearch.setState({
      term: '889244416',
      country: 'US',
      platform: 'ios',
      results: [],
      loading: false,
      error: null,
      searched: false,
    });
    renderSearchPage();

    // The react-i18next stub returns keys, so the select is named by its key.
    fireEvent.click(
      screen.getByRole('combobox', { name: 'downloads.platform.label' }),
    );
    fireEvent.click(screen.getByRole('option', { name: 'tvOS' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(useSearch.getState().platform).toBe('tvos');
    expect(useSearch.getState().searched).toBe(false);
    expect(searchApps).not.toHaveBeenCalled();
    expect(lookupAppById).not.toHaveBeenCalled();

    // The 搜索 button is what starts it.
    fireEvent.change(screen.getAllByRole('textbox')[0], {
      target: { value: '889244416' },
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'search.button' })[0],
    );

    await waitFor(() => expect(lookupAppById).toHaveBeenCalledTimes(1));
  });

  it('says it is checking while the version exchange runs, and is not walkable yet', async () => {
    const pending = deferred<{ versions: string[]; updatedCookies: [] }>();
    mocks.listVersions.mockReturnValue(pending.promise);

    renderSearchPage();

    expect(screen.getByText('search.bareChecking')).toBeTruthy();
    expect(mocks.listVersions).toHaveBeenCalledWith(account, bare, undefined);
    // Nothing to show yet: the detail view must not be reachable.
    expect(screen.queryByRole('link')).toBeNull();

    await act(async () => {
      pending.resolve({ versions: ['883003118'], updatedCookies: [] });
    });

    await waitFor(() =>
      expect(
        useVersionListsStore.getState().lists['6503940939:ios:US'],
      ).toEqual(['883003118']),
    );
    expect(screen.queryByText('search.bareChecking')).toBeNull();
  });

  it('opens a bare record once versions came back', async () => {
    mocks.listVersions.mockResolvedValue({
      versions: ['883003118'],
      updatedCookies: [],
    });

    renderSearchPage();

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.queryByText('search.bareUnverified')).toBeNull();
  });

  it('shows the newest version the exchange found', async () => {
    // The card shows what was learned: the newest build's label, looked up once
    // for that version (not the whole list).
    mocks.listVersions.mockResolvedValue({
      versions: ['883003118', '883003117'],
      updatedCookies: [],
    });
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: '1.3.18', releaseDate: '2025-03-02T00:00:00Z' },
      updatedCookies: [],
    } as never);

    renderSearchPage();

    await waitFor(() => expect(screen.getByText('1.3.18')).toBeTruthy());
    expect(vi.mocked(getVersionMetadata)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getVersionMetadata)).toHaveBeenCalledWith(
      account,
      bare,
      '883003118',
    );

    // Nothing else is known about the app, so the version leads the row and no
    // empty placeholder shifts it (or leaves a blank line above it).
    const versionSpan = screen.getByText('1.3.18');
    expect(Array.from(versionSpan.parentElement?.children ?? [])).toEqual([
      versionSpan,
    ]);
    expect(versionSpan.closest('a')?.querySelectorAll('p')).toHaveLength(1);
  });

  it('shows the version a stored record already carries', async () => {
    // Nothing has to be fetched for a delisted app with a local record.
    useSearch.setState({
      term: 'forward',
      results: [
        { ...bare, name: 'Forward', version: '1.2.0', metadataSource: 'local' },
      ],
    });
    useVersionListsStore.setState({ lists: { '6503940939:ios:US': ['111'] } });

    renderSearchPage();

    expect(screen.getByText('1.2.0')).toBeTruthy();
  });

  it('drops the record and reports a miss when nothing serves the id', async () => {
    mocks.listVersions.mockRejectedValue(new MissingAppError('no such app'));

    renderSearchPage();

    await waitFor(() => expect(screen.getByText('search.noResults')).toBeTruthy());
    expect(screen.queryByText('search.bareRecordTag')).toBeNull();
    expect(useSearch.getState().results).toEqual([]);
    expect(useSearch.getState().searched).toBe(true);
  });

  it('drops the record when Apple refuses to serve the item', async () => {
    // Apple answered about the request and would not serve anything for it —
    // this is what an id it does not know ends up as.
    mocks.listVersions.mockRejectedValue(
      new DownloadError('Item not available', '5001'),
    );

    renderSearchPage();

    await waitFor(() => expect(screen.getByText('search.noResults')).toBeTruthy());
    expect(screen.queryByText('search.bareRecordTag')).toBeNull();
  });

  it('keeps the record, says why, and stays closed when the failure is not about the app', async () => {
    // A session problem says nothing about the id, so nothing is concluded —
    // and with no versions there is nothing to walk into either.
    mocks.listVersions.mockRejectedValue(
      new DownloadError('Your password token has expired', '2034'),
    );

    renderSearchPage();

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.queryByText('search.noResults')).toBeNull();
    expect(screen.getByText('search.bareUnverified')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('verifies a package-index record that has no build for this platform', async () => {
    const pending = deferred<{ versions: string[]; updatedCookies: [] }>();
    mocks.listVersions.mockReturnValue(pending.promise);
    useSearch.setState({
      term: 'forward',
      platform: 'tvos',
      results: [localRecord],
    });

    renderSearchPage();

    expect(screen.getByText('search.localChecking')).toBeTruthy();
    expect(screen.getByText('downloads.add.localRecordTag')).toBeTruthy();
    // Not walkable while the question is open…
    expect(screen.queryByRole('link')).toBeNull();
    // …and the exchange is asked for the platform on screen.
    expect(mocks.listVersions).toHaveBeenCalledWith(
      account,
      { ...localRecord, platform: 'tvos' },
      undefined,
    );

    await act(async () => {
      pending.resolve({ versions: ['883003118'], updatedCookies: [] });
    });

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(screen.queryByText('search.localChecking')).toBeNull();
    expect(screen.queryByText('search.localUnverified')).toBeNull();
  });

  it('keeps a package-index record closed with its reason when the platform serves nothing', async () => {
    // An iOS-only record asked for as tvOS: the app exists, but nothing can name
    // a tvOS build — the card says so and stays closed instead of walking the
    // user into a view with nothing to fetch.
    mocks.listVersions.mockRejectedValue(
      new DownloadError('缺少所需的版本信息'),
    );
    useSearch.setState({
      term: 'forward',
      platform: 'tvos',
      results: [localRecord],
    });

    renderSearchPage();

    await waitFor(() =>
      expect(screen.getByText('search.localUnverified')).toBeTruthy(),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('downloads.add.localRecordTag')).toBeTruthy();
  });

  it('names the missing platform outright when the exchange settles it', async () => {
    // The exchange answered "no build for this platform" — an answer, not a
    // failure to ask — so the card says which platform has nothing instead of
    // reading as an open question, and still does not walk the user in.
    mocks.listVersions.mockRejectedValue(
      new PlatformVersionUnavailableError('no build for platform'),
    );
    useSearch.setState({
      term: 'forward',
      platform: 'macos',
      results: [localRecord],
    });

    renderSearchPage();

    await waitFor(() =>
      expect(
        screen.getByText('search.product.noVersionForPlatform'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText('search.localUnverified')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('does not drop a package-index record Apple has nothing to serve for', async () => {
    // Dropping is for ids nothing vouches for. A compiled package does vouch
    // for this app, so Apple's answer settles this platform at most.
    mocks.listVersions.mockRejectedValue(new MissingAppError('nothing to serve'));
    useSearch.setState({
      term: 'forward',
      platform: 'tvos',
      results: [localRecord],
    });

    renderSearchPage();

    await waitFor(() =>
      expect(screen.getByText('search.localUnverified')).toBeTruthy(),
    );
    expect(screen.queryByText('search.noResults')).toBeNull();
    expect(useSearch.getState().results).toHaveLength(1);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('leaves a package-index record that already covers this platform alone', async () => {
    // Its own platform was recorded here: no open question, so no checking
    // state and no closed card — only the usual silent version prefetch.
    useSearch.setState({
      term: 'forward',
      results: [{ ...localRecord, version: '1.3.19' }],
    });

    renderSearchPage();

    expect(screen.queryByText('search.localChecking')).toBeNull();
    expect(screen.getByRole('link')).toBeTruthy();
    expect(screen.getByText('1.3.19')).toBeTruthy();
    expect(screen.queryByText('search.localUnverified')).toBeNull();
  });

  it('cannot probe without an account, says so, and stays closed', async () => {
    mocks.accounts = [];

    renderSearchPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.listVersions).not.toHaveBeenCalled();
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.getByText('search.bareUnverified')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('probes with the account of the searched region', async () => {
    const otherRegion = { ...account, email: 'jp@example.test', store: '143462' };
    mocks.accounts = [otherRegion, account];

    renderSearchPage();

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(mocks.listVersions).toHaveBeenCalledWith(account, bare, undefined);
  });

  it('does not probe another region and says which one is missing', async () => {
    // Asking from the wrong storefront only earns "Account Not In This Store",
    // which says nothing about the app.
    mocks.accounts = [account];
    useSearch.setState({ country: 'JP' });

    renderSearchPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.listVersions).not.toHaveBeenCalled();
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.getByText('search.bareUnverified')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('reuses the exchange still running when the page is returned to', async () => {
    // The exchange itself has no abort, so leaving cannot call it off — but
    // coming back must not pay for a second one.
    let release: (() => void) | undefined;
    mocks.listVersions.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ versions: ['883003118'], updatedCookies: [] });
        }),
    );

    const first = renderSearchPage();
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    first.unmount();

    renderSearchPage();
    expect(screen.getByText('search.bareChecking')).toBeTruthy();
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
  });

  it('treats a list fetched earlier as settled', async () => {
    // The search page's own prefetch may have answered already: the card opens
    // straight away instead of asking Apple again.
    useVersionListsStore.setState({ lists: { '6503940939:ios:US': ['111'] } });

    renderSearchPage();

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).not.toHaveBeenCalled();
    expect(screen.queryByText('search.bareUnverified')).toBeNull();
  });

  it('settles the probe under StrictMode (mount effects re-arm)', async () => {
    // React StrictMode runs mount effects setup → cleanup → setup; a
    // mountedRef only cleared on cleanup would mute the settled probe forever
    // (the dev-server hang this guards against) — its setup must re-arm it.
    mocks.listVersions.mockResolvedValue({
      versions: ['883003118'],
      updatedCookies: [],
    });

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/search']}>
          <SearchPage />
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('search.bareChecking')).toBeNull();
    expect(screen.queryByText('search.bareUnverified')).toBeNull();
    // The settled fill runs too — a one-way `mounted` guard in the metadata
    // hook would mute it and getVersionMetadata would never be called.
    await waitFor(() =>
      expect(vi.mocked(getVersionMetadata)).toHaveBeenCalled(),
    );
  });

  it('re-verifies a bare record when the region changes', async () => {
    const jpAccount = { ...account, email: 'jp@example.test', store: '143462' };
    mocks.accounts = [account, jpAccount];
    mocks.listVersions
      .mockResolvedValueOnce({ versions: ['883003118'], updatedCookies: [] })
      .mockRejectedValueOnce(new DownloadError('nope', '2034'));
    renderSearchPage();

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);

    // Switching the region must re-ask — with that region's account — instead
    // of settling from the other region's cached list.
    act(() => {
      useSearch.setState({ country: 'JP' });
    });

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(2));
    expect(mocks.listVersions).toHaveBeenNthCalledWith(
      2,
      jpAccount,
      expect.objectContaining({ id: 6503940939 }),
      undefined,
    );
    await waitFor(() =>
      expect(screen.getByText('search.bareUnverified')).toBeTruthy(),
    );
    expect(screen.queryByRole('link')).toBeNull();

    // Back to the verified region: the cached list settles it again with no
    // further exchange.
    act(() => {
      useSearch.setState({ country: 'US' });
    });
    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).toHaveBeenCalledTimes(2);
  });

  it('re-verifies a bare record when the platform changes', async () => {
    mocks.listVersions
      .mockResolvedValueOnce({ versions: ['883003118'], updatedCookies: [] })
      .mockRejectedValueOnce(new DownloadError('no pin', undefined));
    renderSearchPage();

    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);

    // Switching the platform must re-ask for that platform instead of
    // carrying the other platform's verdict.
    act(() => {
      useSearch.setState({ platform: 'tvos' });
    });

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(2));
    expect(mocks.listVersions).toHaveBeenNthCalledWith(
      2,
      account,
      expect.objectContaining({ id: 6503940939, platform: 'tvos' }),
      undefined,
    );
    await waitFor(() =>
      expect(screen.getByText('search.bareUnverified')).toBeTruthy(),
    );
    expect(screen.queryByRole('link')).toBeNull();

    // Back to the verified platform: its cached list settles it again with no
    // further exchange.
    act(() => {
      useSearch.setState({ platform: 'ios' });
    });
    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(mocks.listVersions).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale exchange settle another dimension', async () => {
    const first = deferred<{ versions: string[]; updatedCookies: [] }>();
    const second = deferred<{ versions: string[]; updatedCookies: [] }>();
    mocks.listVersions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderSearchPage();
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));

    // Switch platform mid-flight; tvOS gets its own exchange.
    act(() => {
      useSearch.setState({ platform: 'tvos' });
    });
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(2));

    // The iOS result lands late — it must not settle the tvOS card.
    await act(async () => {
      first.resolve({ versions: ['883003118'], updatedCookies: [] });
    });
    expect(screen.getByText('search.bareChecking')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();

    // The tvOS exchange settles its own card.
    await act(async () => {
      second.resolve({ versions: ['889244416'], updatedCookies: [] });
    });
    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
  });

  it('re-locks the card when returning to a region whose probe never settled', async () => {
    // Leaving a region mid-probe resets its verdict, so a quick return must
    // re-ask (and re-lock) rather than leave a clickable-but-unverified card:
    // the probe state is gone while the prefetch marker used to block the
    // re-fetch.
    const jpAccount = { ...account, email: 'jp@example.test', store: '143462' };
    mocks.accounts = [account, jpAccount];

    const us = deferred<{ versions: string[]; updatedCookies: [] }>();
    const jp = deferred<{ versions: string[]; updatedCookies: [] }>();
    mocks.listVersions
      .mockReturnValueOnce(us.promise)
      .mockReturnValueOnce(jp.promise);

    renderSearchPage();
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));

    // Leave mid-flight: the US exchange never settles, so nothing is cached.
    act(() => {
      useSearch.setState({ country: 'JP' });
    });
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(2));

    // Back again: the US list never landed, so the id must be re-asked and the
    // card re-locked instead of opening into a view that has nothing to show.
    act(() => {
      useSearch.setState({ country: 'US' });
    });

    await waitFor(() =>
      expect(screen.getByText('search.bareChecking')).toBeTruthy(),
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
