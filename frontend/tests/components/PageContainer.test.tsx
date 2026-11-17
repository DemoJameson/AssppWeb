import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import PageContainer from '../../src/components/Layout/PageContainer';

describe('PageContainer', () => {
  beforeEach(() => {
    document.title = '';
  });

  it('keeps one focusable page heading and updates the browser title', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <PageContainer title="Settings">
          <p>Body</p>
        </PageContainer>
      </MemoryRouter>,
    );

    const heading = screen.getByRole('heading', { name: 'Settings' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(document.title).toBe('Settings | Asspp Web');
  });

  it('uses a separate document title when the visible heading lives elsewhere', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <PageContainer documentTitle="Welcome to Asspp Web">
          <h1>Welcome to Asspp Web</h1>
        </PageContainer>
      </MemoryRouter>,
    );

    expect(document.title).toBe('Welcome to Asspp Web | Asspp Web');
  });
});
