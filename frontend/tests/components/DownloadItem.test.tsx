import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DownloadItem from '../../src/components/Download/DownloadItem';
import type { DownloadTask } from '../../src/types';

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
    // A manual download knows only the app id, so the package is the only
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
