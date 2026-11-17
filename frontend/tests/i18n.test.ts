import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';

describe('i18n document language', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('keeps the document language in sync with the active locale', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');

    await i18n.changeLanguage('ru');
    expect(document.documentElement.lang).toBe('ru');
  });
});
