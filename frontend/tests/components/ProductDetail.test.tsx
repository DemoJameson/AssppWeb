import { Profiler, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductDetail from '../../src/components/Search/ProductDetail';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { getDownloadInfo } from '../../src/apple/download';
import {
  fetchPackageVersionMetadata,
  fetchVersionMetadata,
} from '../../src/api/versionMetadata';
import { MissingAppError } from '../../src/apple/errors';
import { useSettingsStore } from '../../src/store/settings';
import { useToastStore } from '../../src/store/toast';
import { useVersionListsStore } from '../../src/store/versionLists';
import { useVersionMetadataStore } from '../../src/store/versionMetadata';
import type { Account, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  startDownload: vi.fn(),
  acquireLicense: vi.fn(),
  toastDownloadError: vi.fn(),
  toastLicenseError: vi.fn(),
  lookupApp: vi.fn(),
  listVersions: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  // The real i18n module (pulled in via apple/download through the metadata
  // hook) still initialises, so the plugin slot has to exist.
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
  useAccounts: () => ({
    accounts: mocks.accounts,
  }),
}));

vi.mock('../../src/hooks/useDownloadAction', () => ({
  useDownloadAction: () => ({
    startDownload: mocks.startDownload,
    acquireLicense: mocks.acquireLicense,
    toastDownloadError: mocks.toastDownloadError,
    toastLicenseError: mocks.toastLicenseError,
    listVersionsWithLicense: mocks.listVersions,
  }),
}));

// The picker's silent fill consults the backend's shared cache first.
vi.mock('../../src/api/versionMetadata', () => ({
  fetchVersionMetadata: vi.fn(),
  saveVersionMetadata: vi.fn(),
  fetchPackageVersionMetadata: vi.fn(),
}));

// The picker prefetches live metadata after opening; the module is stubbed so
// the libcurl-backed exchange never enters the import graph.
vi.mock('../../src/apple/versionLookup', () => ({
  getVersionMetadata: vi.fn(),
}));

// The accurate-date path runs one pinned exchange per version to name the
// package the backend should read; stubbed like every other exchange here.
vi.mock('../../src/apple/download', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/apple/download')
  >();
  return { ...actual, getDownloadInfo: vi.fn() };
});

// The picker prefetches live metadata after opening; the module is stubbed so
// the libcurl-backed exchange never enters the import graph.
vi.mock('../../src/apple/versionLookup', () => ({
  getVersionMetadata: vi.fn(),
}));

vi.mock('../../src/api/search', () => ({
  lookupApp: mocks.lookupApp,
  lookupAppById: mocks.lookupApp,
}));

const app: Software = {
  id: 123456,
  bundleID: 'com.example.utility',
  name: 'Example Utility',
  version: '3.4.5',
  price: 0,
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
  formattedPrice: 'Free',
  primaryGenreName: 'Utilities',
};

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

function deferredPromise() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function renderProductDetail(
  onRender?: () => void,
  appOverrides: Partial<Software> = {},
  routeVersionId?: string,
  routeCountry = 'US',
  strict = false,
) {
  const product = <ProductDetail />;
  const routeApp = { ...app, ...appOverrides };

  const tree = (
    <MemoryRouter
      initialEntries={[
        {
          pathname: `/search/${routeApp.id}`,
          state: {
            app: routeApp,
            country: routeCountry,
            ...(routeVersionId ? { versionId: routeVersionId } : {}),
          },
        },
      ]}
    >
      <Routes>
        <Route
          path="/search/:appId"
          element={
            onRender ? (
              <Profiler id="product-detail" onRender={onRender}>
                {product}
              </Profiler>
            ) : (
              product
            )
          }
        />
      </Routes>
    </MemoryRouter>
  );

  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** The caption a control is actually showing. */
function visibleLabel(control: HTMLElement): string {
  return control.textContent?.trim() ?? '';
}

/** A direct visit — no navigation state, so the page looks the id up itself. */
function renderProductDetailDirect(appId: string) {
  return render(
    <MemoryRouter initialEntries={[`/search/${appId}`]}>
      <Routes>
        <Route path="/search/:appId" element={<ProductDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderProductPreview() {
  return render(
    <MemoryRouter
      initialEntries={['/search/preview?preview=product']}
    >
      <Routes>
        <Route path="/search/:appId" element={<ProductDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProductDetail download action', () => {
  beforeEach(() => {
    mocks.accounts = [account];
    mocks.startDownload.mockReset();
    mocks.acquireLicense.mockReset();
    mocks.toastDownloadError.mockReset();
    mocks.toastLicenseError.mockReset();
    mocks.lookupApp.mockReset();
    mocks.lookupApp.mockResolvedValue(null);
    mocks.listVersions.mockReset();
    mocks.listVersions.mockResolvedValue({ versions: [], updatedCookies: [] });
    vi.mocked(getVersionMetadata).mockClear();
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: '9.9.9', releaseDate: '2026-01-01T00:00:00Z' },
      updatedCookies: [],
    } as never);
    vi.mocked(fetchVersionMetadata).mockReset();
    vi.mocked(fetchVersionMetadata).mockResolvedValue({});
    vi.mocked(getDownloadInfo).mockReset();
    vi.mocked(getDownloadInfo).mockRejectedValue(new Error('not used'));
    vi.mocked(fetchPackageVersionMetadata).mockReset();
    vi.mocked(fetchPackageVersionMetadata).mockResolvedValue(undefined);
    useSettingsStore.setState({ autoFetchVersionInfo: true });
    useVersionMetadataStore.setState({ entries: {}, attempted: {} });
    useVersionListsStore.setState({ lists: {} });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    useToastStore.setState({ toasts: [] });
  });

  it('keeps the download button stable until startDownload resolves', async () => {
    const deferred = deferredPromise();
    mocks.startDownload.mockReturnValue(deferred.promise);
    const user = userEvent.setup();

    const { rerender } = renderProductDetail();
    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    const downloadButton = screen.getByRole('button', {
      name: 'search.product.download',
    });
    const licenseButton = screen.getByRole('button', {
      name: 'search.product.getLicense',
    });
    const iconSlot = downloadButton.querySelector('span[aria-hidden="true"]');

    expect(downloadButton).toHaveClass('w-full', 'min-w-0');
    expect(downloadButton).not.toHaveClass('opacity-50');
    expect(downloadButton).toHaveAttribute('aria-busy', 'false');
    expect(iconSlot).toHaveClass('h-4', 'w-4', 'shrink-0');

    await user.click(downloadButton);

    expect(mocks.startDownload).toHaveBeenCalledOnce();
    expect(mocks.startDownload).toHaveBeenCalledWith(
      account,
      app,
      undefined,
      'US',
    );
    expect(downloadButton).toBeDisabled();
    expect(downloadButton).toHaveAttribute('aria-busy', 'true');
    // The caption stays the button's own while busy — only the spinner says
    // a job is running.
    expect(visibleLabel(downloadButton)).toBe('search.product.download');
    expect(downloadButton).toHaveClass('w-full', 'min-w-0');
    expect(downloadButton).not.toHaveClass('opacity-50');
    expect(downloadButton.querySelector('.animate-spin')).toBeInTheDocument();
    // The icon slot holds the spinner while the download runs — and it stays
    // in the layout on phones now that the buttons sit on a two-column grid.
    expect(iconSlot).toHaveClass('flex');
    expect(accountSelect).toBeDisabled();
    expect(licenseButton).toBeDisabled();

    mocks.accounts = [{ ...account, cookies: [] }];
    rerender(
      <MemoryRouter
        initialEntries={[
          {
            pathname: `/search/${app.id}`,
            state: { app, country: 'US' },
          },
        ]}
      >
        <Routes>
          <Route path="/search/:appId" element={<ProductDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(downloadButton).toBeDisabled();
    expect(downloadButton).toHaveAttribute('aria-busy', 'true');
    expect(visibleLabel(downloadButton)).toBe('search.product.download');
    expect(downloadButton.querySelector('.animate-spin')).toBeInTheDocument();
    expect(mocks.startDownload).toHaveBeenCalledOnce();

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    await waitFor(() => expect(downloadButton).toBeEnabled());
    expect(downloadButton).toHaveAttribute('aria-busy', 'false');
    expect(visibleLabel(downloadButton)).toBe('search.product.download');
    expect(iconSlot).toHaveClass('flex');
    expect(downloadButton).toHaveClass('w-full', 'min-w-0');
    expect(downloadButton).not.toHaveClass('opacity-50');
    expect(downloadButton.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(downloadButton.querySelector('span[aria-hidden="true"]')).toBe(
      iconSlot,
    );
  });

  it('plumbs every action button the same way', () => {
    renderProductDetail();

    const downloadButton = screen.getByRole('button', {
      name: 'search.product.download',
    });
    const buttons = [
      ...(downloadButton.parentElement?.querySelectorAll('button[aria-busy]') ??
        []),
    ];

    // The licence, download and version actions: each reports busy, keeps its
    // own caption, and shows its icon in the slot.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-busy', 'false');
      expect(button.textContent?.trim()).toBeTruthy();
      const buttonIconSlot = button.querySelector('span[aria-hidden="true"]');
      expect(buttonIconSlot).toHaveClass('flex');
      expect(buttonIconSlot?.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('is disabled on the initial commit before an account is selected', async () => {
    const disabledByCommit: boolean[] = [];

    renderProductDetail(() => {
      // Every action reports busy through aria-busy now, so pick the download
      // action out of the row by its caption.
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('button[aria-busy]'),
      ].find((candidate) =>
        candidate.textContent?.includes('search.product.download'),
      );
      if (button) disabledByCommit.push(button.disabled);
    });

    const downloadButton = screen.getByRole('button', {
      name: 'search.product.download',
    });
    expect(disabledByCommit[0]).toBe(true);
    await waitFor(() => expect(downloadButton).toBeEnabled());
  });

  it('keeps license, download, and version actions in one grid', () => {
    renderProductDetail();

    const licenseButton = screen.getByRole('button', {
      name: 'search.product.getLicense',
    });
    const downloadButton = screen.getByRole('button', {
      name: 'search.product.download',
    });
    const selectVersionButton = screen.getByRole('button', {
      name: 'search.product.selectVersion',
    });
    const actionRow = licenseButton.parentElement;

    expect(actionRow).toBe(downloadButton.parentElement);
    expect(actionRow).toBe(selectVersionButton.parentElement);
    // Two columns on phones so icon and label fit; four from sm up, the same
    // slots whichever actions happen to be showing.
    expect(actionRow).toHaveClass('grid', 'grid-cols-2', 'sm:grid-cols-4');
    expect(Array.from(actionRow?.children ?? [])).toEqual([
      licenseButton,
      downloadButton,
      selectVersionButton,
    ]);

    for (const action of [licenseButton, downloadButton, selectVersionButton]) {
      expect(action).toHaveClass('w-full', 'min-w-0');
    }
  });

  it('simulates a preview download without calling real services', async () => {
    vi.useFakeTimers();
    mocks.accounts = [];

    renderProductPreview();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.getByRole('heading', { name: 'Signal Canvas' }),
    ).toBeInTheDocument();
    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    expect(accountSelect).toHaveTextContent('developer@preview.asspp.invalid');
    const downloadButton = screen.getByRole('button', {
      name: 'search.product.download',
    });
    expect(downloadButton).toBeEnabled();
    expect(useToastStore.getState().toasts).toHaveLength(0);

    fireEvent.click(downloadButton);

    expect(downloadButton).toBeDisabled();
    expect(downloadButton).toHaveAttribute('aria-busy', 'true');
    expect(downloadButton.querySelector('.animate-spin')).toBeInTheDocument();
    expect(mocks.lookupApp).not.toHaveBeenCalled();
    expect(mocks.startDownload).not.toHaveBeenCalled();
    expect(mocks.acquireLicense).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(downloadButton).toBeDisabled();
    expect(downloadButton).toHaveAttribute('aria-busy', 'true');
    expect(downloadButton.querySelector('.animate-spin')).toBeInTheDocument();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mocks.lookupApp).not.toHaveBeenCalled();
    expect(mocks.startDownload).not.toHaveBeenCalled();
    expect(mocks.acquireLicense).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(downloadButton).toBeEnabled();
    expect(downloadButton).toHaveAttribute('aria-busy', 'false');
    expect(downloadButton.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(mocks.lookupApp).not.toHaveBeenCalled();
    expect(mocks.startDownload).not.toHaveBeenCalled();
    expect(mocks.acquireLicense).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'search.product.previewActionComplete',
        title: 'search.product.previewBadge',
        type: 'success',
      }),
    ]);
  });

  it('offers every account regardless of its storefront', async () => {
    mocks.accounts = [
      account,
      {
        ...account,
        email: 'jp@example.test',
        store: '143462',
        firstName: 'Jp',
        lastName: 'User',
      },
    ];
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));
    fireEvent.click(accountSelect);
    expect(
      screen.getByRole('option', { name: /jp@example\.test/ }),
    ).toBeInTheDocument();
  });

  it('refetches for the picked account storefront', async () => {
    mocks.accounts = [
      account,
      {
        ...account,
        email: 'jp@example.test',
        store: '143462',
        firstName: 'Jp',
        lastName: 'User',
      },
    ];
    mocks.lookupApp.mockResolvedValue(app);
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(accountSelect);
    fireEvent.click(screen.getByRole('option', { name: /jp@example\.test/ }));

    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenCalledWith(String(app.id), 'JP', 'ios');
    });
  });

  it('refetches for the picked platform', async () => {
    mocks.lookupApp.mockResolvedValue(app);
    renderProductDetail();

    const platformSelect = screen.getByRole('combobox', {
      name: 'downloads.platform.label',
    });
    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(platformSelect);
    fireEvent.click(screen.getByRole('option', { name: 'tvOS' }));

    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenCalledWith(String(app.id), 'US', 'tvos');
    });
  });

  it('folds the shared cache in before asking Apple for version numbers', async () => {
    // The silent policy: what the instance already knows costs no request, so
    // the cache is merged before the fill starts. The entries carry package
    // dates — the only kind a label prints.
    vi.mocked(fetchVersionMetadata).mockResolvedValue({
      '890964826': {
        displayVersion: '8.2.1',
        releaseDate: '2026-05-01T00:00:00Z',
        source: 'package',
      },
      '890657720': {
        displayVersion: '8.2.0',
        releaseDate: '2026-04-01T00:00:00Z',
        source: 'package',
      },
    });
    mocks.listVersions.mockResolvedValue({
      versions: ['890964826', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));

    const combo = await screen.findByRole('combobox', {
      name: 'search.product.version',
    });
    expect(combo).toHaveTextContent('8.2.1 (890964826) · 2026-05-01');
    // Nothing was missing, so Apple was never asked about these two.
    expect(vi.mocked(getVersionMetadata)).not.toHaveBeenCalled();
  });

  it('opens the inline version picker and downloads the picked version', async () => {
    mocks.listVersions.mockResolvedValue({
      versions: ['890964826', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(mocks.listVersions).toHaveBeenCalledWith(account, app, undefined);

    const combo = await screen.findByRole('combobox', {
      name: 'search.product.version',
    });
    // The newest fetched version is the default pick, and the trigger button
    // gives way to the picker.
    expect(combo).toHaveTextContent('890964826');
    expect(
      screen.queryByRole('button', { name: 'search.product.selectVersion' }),
    ).toBeNull();

    fireEvent.click(combo);
    fireEvent.click(screen.getByRole('option', { name: /890657720/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.download' }),
    );

    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload).toHaveBeenCalledWith(
      account,
      app,
      '890657720',
      'US',
    );
  });

  it('looks the version numbers up when the auto-fetch switch is on', async () => {
    // The switch is what the silent fill answers to: opening the picker runs
    // the same lookup the manual 查版本号 button would — one pinned exchange
    // per version, whose package the backend reads the real date out of.
    useSettingsStore.setState({ autoFetchVersionInfo: true });
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: {
        downloadURL: 'https://iosapps.example.com/app.ipa',
        sinfs: [],
        bundleShortVersionString: '9.9.9',
        bundleVersion: '999',
        bundleID: 'com.example.utility',
      },
      updatedCookies: [],
    } as never);
    vi.mocked(fetchPackageVersionMetadata).mockResolvedValue({
      displayVersion: '9.9.9',
      releaseDate: '2026-01-01T00:00:00Z',
      source: 'package',
    });
    mocks.listVersions.mockResolvedValue({
      versions: ['890964826', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );

    await waitFor(() =>
      expect(vi.mocked(fetchPackageVersionMetadata)).toHaveBeenCalledTimes(2),
    );
    expect(vi.mocked(fetchPackageVersionMetadata)).toHaveBeenCalledWith(
      app.id,
      '890964826',
      'https://iosapps.example.com/app.ipa',
    );
    // The exchange is not asked for a date the package already gave.
    expect(vi.mocked(getVersionMetadata)).not.toHaveBeenCalled();

    const combo = screen.getByRole('combobox', {
      name: 'search.product.version',
    });
    expect(combo).toHaveTextContent('9.9.9 (890964826) · 2026-01-01');
    // No manual step is offered: the switch already ran it.
    expect(
      screen.queryByRole('button', {
        name: 'search.product.checkVersionNumbers',
      }),
    ).toBeNull();
  });

  it('offers the manual version lookup right of Download when the silent fill is off', async () => {
    useSettingsStore.setState({ autoFetchVersionInfo: false });
    mocks.listVersions.mockResolvedValue({
      versions: ['890964826', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    // Nothing to look numbers up for until the picker is open.
    expect(
      screen.queryByRole('button', {
        name: 'search.product.checkVersionNumbers',
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );
    await screen.findByRole('combobox', { name: 'search.product.version' });

    // With the switch off, opening the picker must not ask Apple by itself.
    expect(vi.mocked(getVersionMetadata)).not.toHaveBeenCalled();

    const manual = screen.getByRole('button', {
      name: 'search.product.checkVersionNumbers',
    });
    expect(
      screen.getByRole('button', { name: 'search.product.download' })
        .nextElementSibling,
    ).toBe(manual);
  });

  it('runs the version-number lookup on demand from the manual button', async () => {
    useSettingsStore.setState({ autoFetchVersionInfo: false });
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: {
        displayVersion: '8.5.5',
        releaseDate: '2026-09-16T00:00:00Z',
      },
      updatedCookies: [],
    });
    mocks.listVersions.mockResolvedValue({
      versions: ['891427672', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );
    await screen.findByRole('combobox', { name: 'search.product.version' });
    // The silent pass is off — nothing was looked up on its own.
    expect(getVersionMetadata).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'search.product.checkVersionNumbers',
      }),
    );
    await waitFor(() => {
      expect(getVersionMetadata).toHaveBeenCalledTimes(2);
    });
  });

  it("prefetches a delisted app's version list so the picker opens from cache", async () => {
    mocks.listVersions.mockResolvedValue({
      versions: ['890964826', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail(undefined, { metadataSource: 'local' });

    // The background fetch lands in the shared cache on its own…
    await waitFor(() => {
      expect(
        useVersionListsStore.getState().lists['123456:ios:US'],
      ).toBeDefined();
    });
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    expect(mocks.listVersions).toHaveBeenCalledWith(
      account,
      {
        ...app,
        metadataSource: 'local',
      },
      undefined,
    );

    // …and 选择版本 opens straight from it — no second exchange.
    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );
    await screen.findByRole('combobox', { name: 'search.product.version' });
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
  });

  it('downloads the route-supplied version id when nothing else is picked', async () => {
    renderProductDetail(undefined, {}, '818970197');

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.download' }),
    );

    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload).toHaveBeenCalledWith(
      account,
      app,
      '818970197',
      'US',
    );
  });

  it('pins the picker fetch with the route version id and preselects it', async () => {
    mocks.listVersions.mockResolvedValue({
      versions: ['818970197', '890657720'],
      updatedCookies: [],
    });
    renderProductDetail(undefined, {}, '818970197');

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    );
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(mocks.listVersions).toHaveBeenCalledWith(account, app, '818970197');

    const combo = await screen.findByRole('combobox', {
      name: 'search.product.version',
    });
    // The route version id is in the list, so it stays the active pick.
    expect(combo).toHaveTextContent('818970197');

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.download' }),
    );
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload).toHaveBeenCalledWith(
      account,
      app,
      '818970197',
      'US',
    );
  });

  it('marks a delisted record and dashes its missing details', async () => {
    renderProductDetail(undefined, {
      metadataSource: 'local',
      version: '',
      fileSizeBytes: undefined,
      sellerName: '',
      releaseDate: '',
      averageUserRating: 0,
    });

    await waitFor(() => {
      expect(screen.getByText('downloads.add.localRecordNote')).toBeTruthy();
    });
    // The tag lives on the search card only — the detail header stays clean.
    expect(screen.queryByText('downloads.add.localRecordTag')).toBeNull();
    // Missing values hold their spot with an em dash.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    // No platform rating on the local record — the stars stay hidden.
    expect(screen.queryByText(/★/)).toBeNull();
  });

  it("shows the fetched list's newest version instead of the recorded build", async () => {
    useVersionListsStore.setState({
      lists: { '123456:ios:US': ['890657720', '818970197'] },
    });
    useVersionMetadataStore.setState({
      entries: {
        '890657720': {
          versionId: '890657720',
          displayVersion: '9.9.9',
          releaseDate: '2026-01-01T00:00:00Z',
        },
      },
    });
    mocks.listVersions.mockResolvedValue({
      versions: ['890657720', '818970197'],
      updatedCookies: [],
    });
    renderProductDetail(undefined, { metadataSource: 'local' });

    await waitFor(() => {
      // The header chip and the details row both carry the fetched build.
      expect(screen.getAllByText(/9\.9\.9/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('9.9.9', { exact: true })).toBeTruthy();
    // The recorded (stale) build no longer shows.
    expect(screen.queryByText(/3\.4\.5/)).toBeNull();
    expect(screen.queryByText('3.4.5', { exact: true })).toBeNull();
  });

  it('downloads the newest fetched version when nothing else is picked', async () => {
    useVersionListsStore.setState({
      lists: { '123456:ios:US': ['890657720', '818970197'] },
    });
    mocks.listVersions.mockResolvedValue({
      versions: ['890657720', '818970197'],
      updatedCookies: [],
    });
    renderProductDetail(undefined, { metadataSource: 'local' });

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(
      screen.getByRole('button', { name: 'search.product.download' }),
    );
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload).toHaveBeenCalledWith(
      account,
      { ...app, metadataSource: 'local' },
      '890657720',
      'US',
    );
  });

  it('selects the account matching the region picked in search', async () => {
    mocks.accounts = [
      account,
      {
        ...account,
        email: 'jp@example.test',
        store: '143462',
        firstName: 'Jp',
        lastName: 'User',
      },
    ];
    renderProductDetail(undefined, {}, undefined, 'JP');

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() =>
      expect(accountSelect).toHaveTextContent('jp@example.test'),
    );
  });

  it('hides the actions without a region account, until another region is picked', async () => {
    mocks.accounts = [
      { ...account, email: 'jp@example.test', store: '143462', firstName: 'Jp' },
    ];
    mocks.lookupApp.mockResolvedValue(app);
    renderProductDetail();

    // The entry region (US) has no account: no actions, just the notice.
    await waitFor(() =>
      expect(screen.getByText('search.product.noRegionAccount')).toBeTruthy(),
    );
    expect(
      screen.queryByRole('button', { name: 'search.product.download' }),
    ).toBeNull();

    // Picking the JP account moves the region (refetch) and brings them back.
    fireEvent.click(
      screen.getByRole('combobox', { name: 'search.product.account' }),
    );
    fireEvent.click(screen.getByRole('option', { name: /jp@example\.test/ }));
    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenCalledWith(String(app.id), 'JP', 'ios');
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'search.product.download' }),
      ).toBeTruthy(),
    );
  });

  it('does not show a foreign-region account as the current pick', async () => {
    mocks.accounts = [
      { ...account, email: 'jp@example.test', store: '143462', firstName: 'Jp' },
    ];
    mocks.lookupApp.mockResolvedValue(app);
    renderProductDetail();

    // The entry region (US) has no account: the control says so rather than
    // presenting the JP account as if it were selected here.
    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() =>
      expect(accountSelect).toHaveTextContent(
        'search.product.accountNoneInRegion',
      ),
    );
    expect(accountSelect).not.toHaveTextContent('jp@example.test');
    // The notice is an explanation only: the picker above carries the move.
    expect(
      screen.queryByRole('button', { name: 'search.product.useAccountRegion' }),
    ).toBeNull();

    // The JP account is still on offer — under its own group, as a move.
    fireEvent.click(accountSelect);
    expect(screen.getByText('search.product.otherRegionAccounts')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /jp@example\.test/ }));

    await waitFor(() =>
      expect(accountSelect).toHaveTextContent('jp@example.test'),
    );
    expect(screen.queryByText('search.product.noRegionAccount')).toBeNull();
  });

  it('keeps the region account apart from the other regions', async () => {
    mocks.accounts = [
      account,
      { ...account, email: 'jp@example.test', store: '143462', firstName: 'Jp' },
    ];
    renderProductDetail(undefined, {}, undefined, 'JP');

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() =>
      expect(accountSelect).toHaveTextContent('jp@example.test'),
    );

    fireEvent.click(accountSelect);
    expect(screen.getByText('search.product.account')).toBeTruthy();
    expect(screen.getByText('search.product.otherRegionAccounts')).toBeTruthy();
  });

  it('offers the single account as the way out of a region it does not serve', async () => {
    // One account, entered from a search in a region it does not cover: the
    // picker lists it under the other regions and carries the move.
    mocks.accounts = [account];
    mocks.lookupApp.mockResolvedValue(app);
    renderProductDetail(undefined, {}, undefined, 'JP');

    await waitFor(() =>
      expect(screen.getByText('search.product.noRegionAccount')).toBeTruthy(),
    );
    expect(
      screen.queryByRole('button', { name: 'search.product.download' }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('combobox', { name: 'search.product.account' }),
    );
    fireEvent.click(
      screen.getByRole('option', { name: /developer@example\.test/ }),
    );

    // The page moved to the account's own storefront and the actions returned.
    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenLastCalledWith(
        String(app.id),
        'US',
        'ios',
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByText('search.product.noRegionAccount'),
      ).toBeNull(),
    );
    expect(
      screen.getByRole('button', { name: 'search.product.download' }),
    ).toBeTruthy();
  });

  it('does not snap back after an explicit account move misses', async () => {
    // The user chose to leave: a storefront without the app is the truth to
    // show, not a mistake to undo — the old snap-back made a single account
    // inescapable.
    mocks.accounts = [account];
    mocks.lookupApp.mockImplementation((_id: string, c: string) =>
      Promise.resolve(c === 'JP' ? app : null),
    );
    renderProductDetail(undefined, {}, undefined, 'JP');

    await waitFor(() =>
      expect(screen.getByText('search.product.noRegionAccount')).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole('combobox', { name: 'search.product.account' }),
    );
    fireEvent.click(
      screen.getByRole('option', { name: /developer@example\.test/ }),
    );

    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenLastCalledWith(
        String(app.id),
        'US',
        'ios',
      );
    });
    // No snap-back: the numeric id settles into a bare record on the chosen
    // storefront instead of being dragged to the region just left.
    await waitFor(() =>
      expect(
        screen.queryByText('search.product.noRegionAccount'),
      ).toBeNull(),
    );
    expect(mocks.lookupApp).toHaveBeenLastCalledWith(
      String(app.id),
      'US',
      'ios',
    );
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
  });

  it('reverts to the previous region when the app is unavailable there', async () => {
    mocks.accounts = [
      account,
      {
        ...account,
        email: 'jp@example.test',
        store: '143462',
        firstName: 'Jp',
        lastName: 'User',
      },
    ];
    mocks.lookupApp.mockImplementation((_id: string, c: string) =>
      Promise.resolve(c === 'JP' ? null : app),
    );
    renderProductDetail();

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(accountSelect);
    fireEvent.click(screen.getByRole('option', { name: /jp@example\.test/ }));
    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenCalledWith(String(app.id), 'JP', 'ios');
    });

    // Snapped back to the US account/region, with a notice, app intact.
    await waitFor(() =>
      expect(mocks.lookupApp).toHaveBeenLastCalledWith(
        String(app.id),
        'US',
        'ios',
      ),
    );
    // The snap-back re-renders the view (a loading pass unmounts the
    // selectors), so re-query instead of reusing the earlier node.
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'search.product.account' }),
      ).toHaveTextContent(account.email),
    );
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'search.product.regionUnavailable',
        type: 'info',
      }),
    ]);
    expect(
      screen.getByRole('button', { name: 'search.product.download' }),
    ).toBeTruthy();
    expect(screen.queryByText('search.product.notFound')).toBeNull();
  });

  it('reverts to the previous platform when the app is unavailable there', async () => {
    mocks.lookupApp.mockImplementation((_id: string, _c: string, p?: string) =>
      Promise.resolve(p === 'macos' ? null : app),
    );
    renderProductDetail();

    const platformSelect = screen.getByRole('combobox', {
      name: 'downloads.platform.label',
    });
    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    fireEvent.click(platformSelect);
    fireEvent.click(screen.getByRole('option', { name: 'macOS' }));
    await waitFor(() => {
      expect(mocks.lookupApp).toHaveBeenCalledWith(String(app.id), 'US', 'macos');
    });

    await waitFor(() =>
      expect(mocks.lookupApp).toHaveBeenLastCalledWith(
        String(app.id),
        'US',
        'ios',
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'downloads.platform.label' }),
      ).toHaveTextContent('iOS'),
    );
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'search.product.platformUnavailable',
        type: 'info',
      }),
    ]);
    expect(screen.queryByText('search.product.notFound')).toBeNull();
  });

  it('treats a bare App ID record as fetchable instead of not-found', async () => {
    const bare = {
      ...app,
      name: 'App 123456',
      bundleID: '',
      artistName: '',
      metadataSource: 'bare' as const,
    };
    mocks.listVersions.mockResolvedValue({
      versions: ['883003118'],
      updatedCookies: [],
    });
    renderProductDetail(undefined, bare);

    const accountSelect = screen.getByRole('combobox', {
      name: 'search.product.account',
    });
    await waitFor(() => expect(accountSelect).toHaveTextContent(account.email));

    // The background fetch runs for bare records too — versions are reachable.
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(mocks.listVersions).toHaveBeenCalledWith(account, bare, undefined);

    // Nothing is known about the app: no license button, and the tag/note say so.
    expect(
      screen.queryByRole('button', { name: 'search.product.getLicense' }),
    ).toBeNull();
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.getByText('search.bareRecordNote')).toBeTruthy();

    // And the header holds no chip the data cannot fill: a delisted record has
    // no price, so neither a dash nor a "free" nobody reported stands in for
    // one. (The details table below still marks its unknown fields with a dash.)
    const header = screen.getByRole('heading', { level: 1 }).closest('section');
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).queryByText('—')).toBeNull();
    expect(within(header as HTMLElement).queryByText('search.product.free')).toBeNull();
  });

  it('verifies a package-index record that has no build for this platform', async () => {
    // An iOS build was downloaded here; this page asks for tvOS, so the record
    // proves the app exists and nothing more — Apple's answer decides whether
    // anything is fetchable, and a not-found page would be a lie.
    const localNoTvosBuild = {
      ...app,
      version: '',
      metadataSource: 'local' as const,
    };
    mocks.listVersions.mockRejectedValue(new MissingAppError('nothing to serve'));
    renderProductDetail(undefined, localNoTvosBuild);

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('search.product.notFound')).toBeNull();
    expect(screen.getByText('search.localUnverified')).toBeTruthy();
    expect(screen.queryByText('search.bareUnverified')).toBeNull();
  });

  it('leaves a package-index record that covers this platform unverified', async () => {
    const localWithBuild = {
      ...app,
      version: '1.2.0',
      metadataSource: 'local' as const,
    };
    mocks.listVersions.mockRejectedValue(new MissingAppError('nothing to serve'));
    renderProductDetail(undefined, localWithBuild);

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    // Its own platform was recorded: the notice has nothing to report.
    expect(screen.queryByText('search.localUnverified')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'search.product.selectVersion' }),
    ).toBeTruthy();
  });

  it('shows the price chip a storefront result reported', async () => {
    renderProductDetail();

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'search.product.account' })).toHaveTextContent(
        account.email,
      ),
    );
    expect(screen.getByText('Free')).toBeTruthy();
  });

  it('falls back to the free label for a storefront result that omitted the price', async () => {
    // Some storefronts omit `formattedPrice` for free apps, so its absence on a
    // store answer still means "no charge" — the one case the fallback is for.
    renderProductDetail(undefined, { formattedPrice: undefined });

    await waitFor(() =>
      expect(screen.getByText('search.product.free')).toBeTruthy(),
    );
  });

  it('drops the price chip for a delisted record nobody priced', async () => {
    const local = {
      ...app,
      formattedPrice: undefined,
      metadataSource: 'local' as const,
    };
    renderProductDetail(undefined, local);

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'search.product.account' })).toHaveTextContent(
        account.email,
      ),
    );
    // Recalled from the package index, never priced here: no chip at all.
    expect(screen.queryByText('search.product.free')).toBeNull();
  });

  it('falls through to not-found when the exchange says the App ID is no app', async () => {
    const bare = {
      ...app,
      name: 'App 123456',
      bundleID: '',
      artistName: '',
      metadataSource: 'bare' as const,
    };
    mocks.listVersions.mockRejectedValue(new MissingAppError('no such app'));
    renderProductDetail(undefined, bare);

    await waitFor(() =>
      expect(screen.getByText('search.product.notFound')).toBeTruthy(),
    );
    expect(screen.queryByText('search.bareRecordTag')).toBeNull();
  });

  it('keeps a bare record and says why when the failure is not about the app', async () => {
    const bare = {
      ...app,
      name: 'App 123456',
      bundleID: '',
      artistName: '',
      version: '',
      metadataSource: 'bare' as const,
    };
    mocks.listVersions.mockRejectedValue(new Error('session expired'));
    renderProductDetail(undefined, bare);

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('search.product.notFound')).toBeNull();
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.getByText('search.bareUnverified')).toBeTruthy();
  });

  it('never erases a locally recorded app on a "no such app" answer', async () => {
    // A compiled package is evidence the app exists; Apple having nothing to
    // serve for it says nothing about that.
    mocks.listVersions.mockRejectedValue(new MissingAppError('no such app'));
    renderProductDetail(undefined, { metadataSource: 'local' });

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('search.product.notFound')).toBeNull();
    // The record is kept — the header still names the app, the note explains
    // where it came from.
    expect(screen.getByText('downloads.add.localRecordNote')).toBeTruthy();
  });

  it('never says "unverified" once versions are known', async () => {
    // The search page's probe already fetched the list: the app is verified,
    // so the notice must not show even though no account is configured.
    const bare = {
      ...app,
      name: 'App 123456',
      bundleID: '',
      artistName: '',
      version: '',
      metadataSource: 'bare' as const,
    };
    mocks.accounts = [];
    useVersionListsStore.setState({ lists: { '123456:ios:US': ['883003118'] } });

    renderProductDetail(undefined, bare);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
    expect(screen.queryByText('search.bareUnverified')).toBeNull();
    expect(mocks.listVersions).not.toHaveBeenCalled();
  });

  it('probes an unknown App ID reached without navigation state', async () => {
    mocks.listVersions.mockResolvedValue({
      versions: ['883003118'],
      updatedCookies: [],
    });
    renderProductDetailDirect('6503940939');

    // The storefront has no record of the id, so the version exchange decides.
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledTimes(1));
    expect(mocks.listVersions).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        id: 6503940939,
        name: 'App 6503940939',
        metadataSource: 'bare',
      }),
      undefined,
    );
    expect(screen.queryByText('search.product.notFound')).toBeNull();
    expect(screen.getByText('search.bareRecordTag')).toBeTruthy();
  });

  it('reports no such app for an unknown id reached without navigation state', async () => {
    mocks.listVersions.mockRejectedValue(new MissingAppError('no such app'));
    renderProductDetailDirect('6503940939');

    await waitFor(() =>
      expect(screen.getByText('search.product.notFound')).toBeTruthy(),
    );
  });

  it('settles its probe under StrictMode (mount effects re-arm)', async () => {
    const bare = {
      ...app,
      name: 'App 123456',
      bundleID: '',
      artistName: '',
      version: '',
      metadataSource: 'bare' as const,
    };
    mocks.listVersions.mockRejectedValue(new Error('session expired'));
    renderProductDetail(undefined, bare, undefined, 'US', true);

    // The settled failure must reach the page: a one-way mountedRef would
    // mute it forever under StrictMode's setup → cleanup → setup mount.
    await waitFor(() =>
      expect(screen.getByText('search.bareUnverified')).toBeTruthy(),
    );
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
  });
});
