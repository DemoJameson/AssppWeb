import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileNav from '../../src/components/Layout/MobileNav';
import Sidebar from '../../src/components/Layout/Sidebar';
import { useDownloadsStore } from '../../src/store/downloads';
import type { DownloadTask } from '../../src/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const task = (status: DownloadTask['status']) =>
  ({ id: `${status}-${Math.random()}`, status }) as unknown as DownloadTask;

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const downloadsLink = () =>
  screen.getByRole('link', { name: 'nav.downloads' });

describe('Downloads tab badge', () => {
  beforeEach(() => {
    useDownloadsStore.setState({ tasks: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows no badge while nothing is downloading (mobile)', () => {
    renderInRouter(<MobileNav />);

    expect(downloadsLink().textContent).toBe('nav.downloads');
  });

  it('shows the active download count on the mobile tab', () => {
    useDownloadsStore.setState({
      tasks: [task('downloading'), task('injecting'), task('completed')],
    });
    renderInRouter(<MobileNav />);

    expect(downloadsLink().textContent).toContain('2');
  });

  it('shows no badge while nothing is downloading (sidebar)', () => {
    renderInRouter(<Sidebar />);

    expect(downloadsLink().textContent).toBe('nav.downloads');
  });

  it('shows the active download count in the sidebar', () => {
    useDownloadsStore.setState({
      tasks: [task('downloading'), task('completed')],
    });
    renderInRouter(<Sidebar />);

    expect(downloadsLink().textContent).toContain('1');
  });
});
