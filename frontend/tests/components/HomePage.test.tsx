import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage, {
  resetHomeStatsCache,
} from '../../src/components/Welcome/HomePage';
import type { Account } from '../../src/types';

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  loading: false,
  apiGet: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({
    accounts: mocks.accounts,
    loading: mocks.loading,
    loadAccounts: vi.fn(),
    addAccount: vi.fn(),
    removeAccount: vi.fn(),
    updateAccount: vi.fn(),
    getAccount: vi.fn(),
  }),
}));

vi.mock('../../src/api/client', () => ({
  apiGet: mocks.apiGet,
}));

const account: Account = {
  email: 'dev@example.test',
  password: 'secret',
  appleId: 'dev@example.test',
  store: '143441',
  firstName: 'Dev',
  lastName: 'Tester',
  passwordToken: 'token',
  directoryServicesIdentifier: '123456789',
  cookies: [],
  deviceIdentifier: 'aabbccddeeff',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

/** Two tasks and one compiled package, so every stat has a distinct value. */
function mockCounts() {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/downloads')) {
      return Promise.resolve([{ id: 1 }, { id: 2 }]);
    }
    return Promise.resolve([{ id: 1 }]);
  });
}

describe('HomePage stats', () => {
  beforeEach(() => {
    resetHomeStatsCache();
    mocks.accounts = [account];
    mocks.loading = false;
    mocks.apiGet.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('never shows a premature zero while the counts are unknown', async () => {
    mockCounts();
    renderPage();

    // Synchronously after mount the counts are unknown, so nothing may render
    // a zero — the cards show placeholders until the real numbers arrive.
    expect(screen.queryAllByText('0')).toHaveLength(0);

    await waitFor(() => {
      expect(screen.getByText('2')).toBeTruthy();
    });
    // accounts = 1 and packages = 1 share the same label.
    expect(screen.getAllByText('1')).toHaveLength(2);
    expect(screen.queryAllByText('0')).toHaveLength(0);
  });

  it('waits for the account store before counting', async () => {
    mocks.loading = true;
    mockCounts();
    renderPage();

    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(screen.queryAllByText('0')).toHaveLength(0);

    cleanup();
    mocks.loading = false;
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('2')).toBeTruthy();
    });
  });

  it('revisiting the page shows the cached numbers immediately', async () => {
    mockCounts();
    const first = renderPage();
    await waitFor(() => {
      expect(screen.getByText('2')).toBeTruthy();
    });
    first.unmount();

    // Revisit with the network stalling: the previous numbers must render
    // right away from the cache — no placeholders, no flicker back to zero.
    mocks.apiGet.mockImplementation(() => new Promise(() => {}));
    renderPage();

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getAllByText('1')).toHaveLength(2);
  });

  it('settles on genuine zeros when there are no accounts', async () => {
    mocks.accounts = [];
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText('0')).toHaveLength(3);
    });
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});
