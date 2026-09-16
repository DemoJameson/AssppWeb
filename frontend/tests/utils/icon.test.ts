import { describe, it, expect } from 'vitest';
import { taskIconUrl } from '../../src/utils/icon';
import type { DownloadTask, Software } from '../../src/types';

function software(overrides: Partial<Software> = {}): Software {
  return {
    id: 6503940939,
    bundleID: 'com.example.app',
    name: 'Example',
    version: '1.0',
    artistName: '',
    sellerName: '',
    description: '',
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: '',
    screenshotUrls: [],
    minimumOsVersion: '',
    releaseDate: '',
    primaryGenreName: '',
    ...overrides,
  };
}

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-id',
    software: software(),
    accountHash: 'hash1234567890',
    status: 'completed',
    progress: 100,
    speed: '0 B/s',
    createdAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('taskIconUrl', () => {
  it('uses the storefront artwork when the storefront knew the app', () => {
    expect(
      taskIconUrl(
        task({
          software: software({ artworkUrl: 'https://cdn.apple.com/art.png' }),
        }),
      ),
    ).toBe('https://cdn.apple.com/art.png');
  });

  it('falls back to the icon lifted out of the package', () => {
    // The whole point of the manual download page: an app looked up by id with
    // no storefront metadata behind it still gets an icon.
    expect(taskIconUrl(task({ hasIcon: true }))).toBe(
      '/api/downloads/task-id/icon?accountHash=hash1234567890',
    );
  });

  it('returns nothing when neither source has an icon', () => {
    expect(taskIconUrl(task({ hasIcon: false }))).toBeUndefined();
    expect(taskIconUrl(task())).toBeUndefined();
  });
});
