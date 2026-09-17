import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ManualDownload from '../../src/components/Download/ManualDownload';
import type { Account, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  startDownload: vi.fn(),
  toastDownloadError: vi.fn(),
  lookupAppById: vi.fn(),
  listVersions: vi.fn(),
  updateAccount: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({
    accounts: mocks.accounts,
    updateAccount: mocks.updateAccount,
  }),
}));

vi.mock('../../src/hooks/useDownloadAction', () => ({
  useDownloadAction: () => ({
    startDownload: mocks.startDownload,
    toastDownloadError: mocks.toastDownloadError,
  }),
}));

vi.mock('../../src/store/toast', () => ({
  useToastStore: (selector: (state: { addToast: unknown }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

vi.mock('../../src/api/search', () => ({
  lookupAppById: mocks.lookupAppById,
  lookupApp: vi.fn(),
}));

vi.mock('../../src/apple/versionFinder', () => ({
  listVersions: mocks.listVersions,
}));

// The settings store is read without a selector, mirroring AddDownload.
vi.mock('../../src/store/settings', () => ({
  useSettingsStore: (
    selector?: (state: { defaultCountry: string; defaultPlatform: string }) => unknown,
  ) => {
    const state = { defaultCountry: 'US', defaultPlatform: 'ios' };
    return selector ? selector(state) : state;
  },
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

const resolvedApp: Software = {
  id: 1492142120,
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
  platform: 'ios',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ManualDownload />
    </MemoryRouter>,
  );
}

const appIdInput = () => screen.getByLabelText('downloads.manual.appId');
const versionIdInput = () => screen.getByLabelText('downloads.manual.versionId');
const downloadButton = () =>
  screen.getByRole('button', { name: 'downloads.manual.download' });
const loadVersionsButton = () =>
  screen.getByRole('button', { name: 'downloads.manual.loadVersions' });

describe('ManualDownload', () => {
  beforeEach(() => {
    mocks.accounts = [account];
    mocks.startDownload.mockReset();
    mocks.startDownload.mockResolvedValue(undefined);
    mocks.toastDownloadError.mockReset();
    mocks.lookupAppById.mockReset();
    mocks.lookupAppById.mockResolvedValue(resolvedApp);
    mocks.listVersions.mockReset();
    mocks.listVersions.mockResolvedValue({
      versions: ['890964826', '890657720'],
      updatedCookies: [],
    });
    mocks.updateAccount.mockReset();
    mocks.updateAccount.mockResolvedValue(undefined);
    mocks.addToast.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers the platform and account selectors and both id fields', async () => {
    renderPage();

    expect(
      screen.getByRole('combobox', { name: 'downloads.platform.label' }),
    ).toBeTruthy();
    expect(appIdInput()).toBeTruthy();
    expect(versionIdInput()).toBeTruthy();

    await waitFor(() => {
      expect(
        screen.getByRole('option', {
          name: 'countries.US - Example Developer (developer@example.test)',
        }),
      ).toBeTruthy();
    });
  });

  it('keeps the download button disabled until a numeric app id is entered', () => {
    renderPage();

    expect((downloadButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(appIdInput(), { target: { value: 'com.example.app' } });
    expect(screen.getByText('downloads.manual.invalidAppId')).toBeTruthy();
    expect((downloadButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    expect(screen.queryByText('downloads.manual.invalidAppId')).toBeNull();
    expect((downloadButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('rejects a non-numeric version id', () => {
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.change(versionIdInput(), { target: { value: 'latest' } });

    expect(screen.getByText('downloads.manual.invalidVersionId')).toBeTruthy();
    expect((downloadButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('resolves the id through the catalogue and starts a download for the latest version', async () => {
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledTimes(1);
    });

    expect(mocks.lookupAppById).toHaveBeenCalledWith('1492142120', 'US', 'ios');
    const [calledAccount, calledApp, calledVersion] =
      mocks.startDownload.mock.calls[0];
    expect(calledAccount).toEqual(account);
    expect(calledApp).toEqual({ ...resolvedApp, releaseDate: '' });
    expect(calledVersion).toBeUndefined();
  });

  it('passes an entered version id through to the download', async () => {
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.change(versionIdInput(), { target: { value: '818970197' } });
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledTimes(1);
    });

    expect(mocks.startDownload.mock.calls[0][2]).toBe('818970197');
  });

  it('downloads from the bare id when the catalogue does not know it', async () => {
    mocks.lookupAppById.mockResolvedValue(null);
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledTimes(1);
    });

    const calledApp = mocks.startDownload.mock.calls[0][1] as Software;
    expect(calledApp.id).toBe(1492142120);
    expect(calledApp.bundleID).toBe('');
    expect(calledApp.platform).toBe('ios');
    expect(screen.getByText('downloads.manual.notFoundNote')).toBeTruthy();
  });

  it('reports a failed download instead of leaving the page silent', async () => {
    const failure = new Error('download failed');
    mocks.startDownload.mockRejectedValue(failure);
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(mocks.toastDownloadError).toHaveBeenCalledTimes(1);
    });

    expect(mocks.toastDownloadError.mock.calls[0][2]).toBe(failure);
  });

  it('loads versions and switches the version id field to a select prefilled with the newest id', async () => {
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(loadVersionsButton());

    await waitFor(() => {
      expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    });

    expect(mocks.lookupAppById).toHaveBeenCalledWith('1492142120', 'US', 'ios');
    const select = screen.getByLabelText(
      'downloads.manual.versionId',
    ) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('890964826');
    expect(screen.getByRole('option', { name: '890657720' })).toBeTruthy();
    expect(mocks.updateAccount).toHaveBeenCalledTimes(1);
  });

  it('downloads the version picked from the loaded list', async () => {
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(loadVersionsButton());
    await waitFor(() => {
      expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(versionIdInput(), { target: { value: '890657720' } });
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(mocks.startDownload).toHaveBeenCalledTimes(1);
    });
    expect(mocks.startDownload.mock.calls[0][2]).toBe('890657720');
  });

  it('shows an error toast when loading versions fails', async () => {
    mocks.listVersions.mockRejectedValue(new Error('boom'));
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(loadVersionsButton());

    await waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith('boom', 'error');
    });
    expect(
      (screen.getByLabelText('downloads.manual.versionId') as HTMLInputElement)
        .tagName,
    ).toBe('INPUT');
  });

  it('loads versions from the bare id when the catalogue does not know it', async () => {
    mocks.lookupAppById.mockResolvedValue(null);
    renderPage();

    fireEvent.change(appIdInput(), { target: { value: '1492142120' } });
    fireEvent.click(loadVersionsButton());

    await waitFor(() => {
      expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    });

    const calledApp = mocks.listVersions.mock.calls[0][1] as Software;
    expect(calledApp.id).toBe(1492142120);
    expect(calledApp.bundleID).toBe('');
    expect(calledApp.platform).toBe('ios');

    const select = screen.getByLabelText(
      'downloads.manual.versionId',
    ) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('890964826');
  });
});
