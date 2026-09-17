import { describe, expect, it } from 'vitest';
import { formatBytes, BYTE_BASE } from '../../src/utils/format';

describe('formatBytes', () => {
  it('returns a placeholder for missing or invalid values', () => {
    expect(formatBytes()).toBe('—');
    expect(formatBytes('')).toBe('—');
    expect(formatBytes('not-a-number')).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('formats zero and byte values without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(BYTE_BASE - 1)).toBe(`${BYTE_BASE - 1} B`);
  });

  it('formats numeric strings and larger units with useful precision', () => {
    expect(formatBytes(String(BYTE_BASE))).toBe('1.0 KB');
    expect(formatBytes(1.5 * BYTE_BASE)).toBe('1.5 KB');
    expect(formatBytes(5 * BYTE_BASE ** 2)).toBe('5.0 MB');
    expect(formatBytes(120 * BYTE_BASE ** 2)).toBe('120 MB');
    expect(formatBytes(2.5 * BYTE_BASE ** 3)).toBe('2.5 GB');
  });
});
