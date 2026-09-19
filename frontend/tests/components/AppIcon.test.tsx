import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppIcon from '../../src/components/common/AppIcon';

describe('AppIcon', () => {
  it('shows the Apple mark for the App <id> placeholder name', () => {
    render(<AppIcon name="App 6503940939" />);

    const box = screen.getByRole('img', { name: 'App 6503940939' });
    expect(box.querySelector('svg')).not.toBeNull();
    expect(box.textContent).toBe('');
  });

  it('keeps the letter fallback for a real name', () => {
    render(<AppIcon name="Forward" />);

    const box = screen.getByRole('img', { name: 'Forward' });
    expect(box.textContent).toBe('F');
    expect(box.querySelector('svg')).toBeNull();
  });

  it('renders the artwork when a url is given', () => {
    render(<AppIcon url="https://example.com/icon.png" name="Forward" />);

    expect(screen.getByAltText('Forward').getAttribute('src')).toBe(
      'https://example.com/icon.png',
    );
  });
});
