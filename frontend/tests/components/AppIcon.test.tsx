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

  it('requests the rendered size from Apple image URLs', () => {
    render(
      <AppIcon
        url="https://is1-ssl.mzstatic.com/image/thumb/example/512x512bb.jpg"
        name="Forward"
      />,
    );

    const image = screen.getByAltText('Forward');
    expect(image).toHaveAttribute(
      'src',
      'https://is1-ssl.mzstatic.com/image/thumb/example/56x56bb.jpg',
    );
    expect(image).toHaveAttribute(
      'srcset',
      'https://is1-ssl.mzstatic.com/image/thumb/example/56x56bb.jpg 56w, https://is1-ssl.mzstatic.com/image/thumb/example/112x112bb.jpg 112w, https://is1-ssl.mzstatic.com/image/thumb/example/168x168bb.jpg 168w, https://is1-ssl.mzstatic.com/image/thumb/example/224x224bb.jpg 224w',
    );
    expect(image).toHaveAttribute('sizes', '3.5rem');
    expect(image).toHaveAttribute('width', '56');
    expect(image).toHaveAttribute('height', '56');
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('does not upscale artwork smaller than the slot', () => {
    render(
      <AppIcon
        url="https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg"
        name="Forward"
      />,
    );

    const image = screen.getByAltText('Forward');
    expect(image).toHaveAttribute(
      'srcset',
      'https://is1-ssl.mzstatic.com/image/thumb/example/56x56bb.jpg 56w, https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg 100w',
    );
  });

  it('can be decorative when adjacent text already carries the name', () => {
    render(
      <AppIcon
        url="https://example.com/icon.png"
        name="Forward"
        decorative
      />,
    );

    expect(screen.queryByAltText('Forward')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
