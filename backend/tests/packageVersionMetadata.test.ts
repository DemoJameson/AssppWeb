import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync } from 'node:zlib';
import {
  readVersionMetadataFromRanges,
  readVersionMetadataFromXarRanges,
  versionMetadataFromDownloadURL,
} from '../src/services/packageVersionMetadata.js';

/**
 * Builds a zip in memory, entries stored (method 0) or deflated (method 8).
 * The parser only reads ranges of an archive, so a hand-built one is both
 * cheaper than a real package and deterministic — and it lets the test declare
 * the entry dates ipatool falls back to.
 */
function buildZip(
  entries: { name: string; data: Buffer; at?: Date; method?: 0 | 8 }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const at = entry.at ?? new Date(0);
    const dosTime =
      ((at.getUTCHours() & 0x1f) << 11) |
      ((at.getUTCMinutes() & 0x3f) << 5) |
      ((at.getUTCSeconds() / 2) & 0x1f);
    const dosDate =
      (((at.getUTCFullYear() - 1980) & 0x7f) << 9) |
      (((at.getUTCMonth() + 1) & 0x0f) << 5) |
      (at.getUTCDate() & 0x1f);
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(0, 14); // crc32, never checked by the reader
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const infoPlist = (version: string, extra = '') =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string>${extra}</dict></plist>`,
    'utf8',
  );

/** Serves ranges the way the CDN would: [start, end] inclusive. */
const readerOver = (archive: Buffer) => async (start: number, end: number) =>
  archive.subarray(start, end + 1);

function buildPreflightXar(distribution: string): Buffer {
  const data = Buffer.from(distribution, 'utf8');
  const extractedChecksum = createHash('sha1').update(data).digest('hex');
  const file = `<file id="1"><type>file</type><name>Distribution</name><data><length>${data.length}</length><offset>20</offset><size>${data.length}</size><encoding style="application/octet-stream"/><archived-checksum style="sha1">${extractedChecksum}</archived-checksum><extracted-checksum style="sha1">${extractedChecksum}</extracted-checksum></data></file>`;
  const toc = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><xar><toc><checksum style="sha1"><offset>0</offset><size>20</size></checksum>${file}</toc></xar>`,
    'utf8',
  );
  const compressedToc = deflateSync(toc);
  const tocChecksum = createHash('sha1').update(compressedToc).digest();
  const archive = Buffer.alloc(28 + compressedToc.length + 20 + data.length);
  archive.write('xar!', 0, 'latin1');
  archive.writeUInt16BE(28, 4);
  archive.writeUInt16BE(1, 6);
  archive.writeBigUInt64BE(BigInt(compressedToc.length), 8);
  archive.writeBigUInt64BE(BigInt(toc.length), 16);
  archive.writeUInt32BE(1, 24);
  compressedToc.copy(archive, 28);
  tocChecksum.copy(archive, 28 + compressedToc.length);
  data.copy(archive, 28 + compressedToc.length + 20);
  return archive;
}

function preflightDistribution(version: string, packageVersion: string): string {
  return `<installer-gui-script><product id="com.example.mac" version="${version}"/><pkg-ref id="com.example.pkg"><relocate><bundle id="com.example.mac"/></relocate></pkg-ref><pkg-ref id="com.unrelated.pkg" version="9.9.9.0.1.1700000000"/><pkg-ref id="com.example.pkg" version="${packageVersion}"/><pkg-ref id="com.example.pkg" version="${packageVersion}"/></installer-gui-script>`;
}

describe('readVersionMetadataFromRanges', () => {
  it('reads the version out of the payload and dates it from the entry time', async () => {
    const zip = buildZip([
      {
        name: 'Payload/Sample.app/Info.plist',
        data: infoPlist('2.1.0'),
        at: new Date('2025-03-04T05:06:08Z'),
      },
    ]);

    const metadata = await readVersionMetadataFromRanges(
      readerOver(zip),
      zip.length,
    );

    expect(metadata.displayVersion).toBe('2.1.0');
    // No date in the plist: the archive entry's modification time is the fall-
    // back, exactly like ipatool.
    expect(metadata.releaseDate).toBe(
      new Date('2025-03-04T05:06:08Z').toISOString(),
    );
  });

  it('prefers the plist’s own release date', async () => {
    const zip = buildZip([
      {
        name: 'Payload/Sample.app/Info.plist',
        data: infoPlist(
          '2.1.0',
          '<key>releaseDate</key><date>2025-01-02T03:04:05Z</date>',
        ),
        at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const metadata = await readVersionMetadataFromRanges(
      readerOver(zip),
      zip.length,
    );

    expect(metadata.releaseDate).toBe('2025-01-02T03:04:05.000Z');
  });

  it('never takes the date from the iTunesMetadata Apple handed out', async () => {
    // That document dates the app, not the build: the exchange's own value and
    // the one inside the package are the same stale day.
    const zip = buildZip([
      {
        name: 'iTunesMetadata.plist',
        data: infoPlist('2.1.0', '<key>releaseDate</key><date>2024-01-01T07:00:00Z</date>'),
        at: new Date('2024-01-01T07:00:00Z'),
      },
      {
        name: 'Payload/Sample.app/Info.plist',
        data: infoPlist('2.1.0'),
        at: new Date('2025-06-07T08:09:10Z'),
      },
    ]);

    const metadata = await readVersionMetadataFromRanges(
      readerOver(zip),
      zip.length,
    );

    expect(metadata.releaseDate).not.toBe('2024-01-01T07:00:00.000Z');
    expect(metadata.releaseDate).toBe('2025-06-07T08:09:10.000Z');
  });

  it('ignores anything that is not the payload’s own Info.plist', async () => {
    const zip = buildZip([
      {
        name: 'Payload/Sample.app/PlugIn/Inner.app/Info.plist',
        data: infoPlist('9.9.9'),
        at: new Date('2020-01-01T00:00:00Z'),
      },
    ]);

    await expect(
      readVersionMetadataFromRanges(readerOver(zip), zip.length),
    ).rejects.toThrow();
  });

  it('inflates a deflated (method 8) Info.plist — how real IPAs ship', async () => {
    const zip = buildZip([
      {
        name: 'Payload/Sample.app/Info.plist',
        data: infoPlist('3.2.1'),
        method: 8,
        at: new Date('2025-06-07T08:09:10Z'),
      },
    ]);

    const metadata = await readVersionMetadataFromRanges(
      readerOver(zip),
      zip.length,
    );

    expect(metadata.displayVersion).toBe('3.2.1');
    expect(metadata.releaseDate).toBe('2025-06-07T08:09:10.000Z');
  });

  it('refuses a zip64 archive instead of walking nonsense offsets', async () => {
    // The 0xFFFFFFFF marker in the directory-offset field is the zip64 signal:
    // the real value lives in extra records this reader does not walk.
    const zip = buildZip([
      {
        name: 'Payload/Sample.app/Info.plist',
        data: infoPlist('1.0.0'),
        at: new Date('2020-01-01T00:00:00Z'),
      },
    ]);
    // The EOCD is the last 22 bytes; its directory-offset field sits at +16.
    const markerAt = zip.length - 22 + 16;
    zip.writeUInt32LE(0xffffffff, markerAt);

    await expect(
      readVersionMetadataFromRanges(readerOver(zip), zip.length),
    ).rejects.toThrow('zip64 archives are not supported');
  });

  it('rejects a truncated central directory instead of a raw RangeError', async () => {
    const zip = buildZip([
      { name: 'Payload/Sample.app/Info.plist', data: infoPlist('1.0.0') },
    ]);
    // Claim more entries than the directory actually holds: the second walk step
    // would read past the directory and, without the guard, throw a RangeError.
    const entryCountAt = zip.length - 22 + 10;
    zip.writeUInt16LE(5, entryCountAt);

    await expect(
      readVersionMetadataFromRanges(readerOver(zip), zip.length),
    ).rejects.toThrow('unreadable central directory');
  });

  it('rejects an entry whose declared uncompressed size is huge', async () => {
    const zip = buildZip([
      {
        name: 'Payload/Sample.app/Info.plist',
        data: infoPlist('1.0.0'),
        method: 8,
      },
    ]);
    // Rewrite the central directory's uncompressed-size field to claim far more than the
    // output cap: a small payload that lies about its size must be refused before inflation.
    const directoryOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(0x7fffffff, directoryOffset + 24);

    await expect(
      readVersionMetadataFromRanges(readerOver(zip), zip.length),
    ).rejects.toThrow('entry too large');
  });
});


describe('readVersionMetadataFromXarRanges', () => {
  it('reads the selected legacy Mac version and its installer timestamp', async () => {
    const archive = buildPreflightXar(
      preflightDistribution('4.2', '4.2.0.0.1.1341568473'),
    );

    const metadata = await readVersionMetadataFromXarRanges(
      readerOver(archive),
      archive.length,
      'com.example.mac',
    );

    expect(metadata.displayVersion).toBe('4.2');
    expect(metadata.releaseDate).toBe('2012-07-06T09:54:33.000Z');
  });

  it('rejects a preflight archive for a different bundle', async () => {
    const archive = buildPreflightXar(
      preflightDistribution('4.2', '4.2.0.0.1.1341568473'),
    );

    await expect(
      readVersionMetadataFromXarRanges(
        readerOver(archive),
        archive.length,
        'com.other.mac',
      ),
    ).rejects.toThrow('requested bundle');
  });

  it('rejects a package version that is not a legacy build timestamp', async () => {
    const archive = buildPreflightXar(
      preflightDistribution('4.2', '4.2.0'),
    );

    await expect(
      readVersionMetadataFromXarRanges(readerOver(archive), archive.length),
    ).rejects.toThrow('supported build timestamp');
  });
});


describe('versionMetadataFromDownloadURL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes a legacy Mac preflight XAR and validates its bundle', async () => {
    const archive = buildPreflightXar(
      preflightDistribution('4.2', '4.2.0.0.1.1341568473'),
    );
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(archive.length) },
        });
      }

      const range = String(
        (init?.headers as Record<string, string> | undefined)?.Range ?? '',
      );
      const match = /bytes=(\d+)-(\d+)/.exec(range);
      if (!match) return new Response(archive, { status: 200 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), archive.length - 1);
      return new Response(archive.subarray(start, end + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${archive.length}`,
        },
      });
    });

    await expect(
      versionMetadataFromDownloadURL(
        'https://example.apple.com/preflight.pkg',
        'com.example.mac',
      ),
    ).resolves.toEqual({
      displayVersion: '4.2',
      releaseDate: '2012-07-06T09:54:33.000Z',
    });
  });
});
