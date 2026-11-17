import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Modal from '../../src/components/common/Modal';

describe('Modal', () => {
  it('opens a native modal with a labelled title and no redundant ARIA', () => {
    const showModal = vi.spyOn(
      HTMLDialogElement.prototype,
      'showModal',
    );
    const { container } = render(
      <Modal open onClose={() => {}} title="Confirm">
        <button type="button">Cancel</button>
      </Modal>,
    );

    const dialog = container.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveAttribute('closedby', 'any');
    expect(dialog).not.toHaveAttribute('role');
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(
      screen.getByRole('dialog', { name: 'Confirm' }),
    ).toBe(dialog);
    expect(showModal).toHaveBeenCalledTimes(1);

    showModal.mockRestore();
  });

  it('closes when the native dialog closes', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Confirm">
        <button type="button">Cancel</button>
      </Modal>,
    );
    const dialog = container.querySelector('dialog') as HTMLDialogElement;

    dialog.close();

    expect(dialog).not.toHaveAttribute('open');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports click-outside dismissal without swallowing inner clicks', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Confirm">
        <button type="button">Cancel</button>
      </Modal>,
    );
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 310,
      bottom: 210,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Cancel' }), {
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Cancel' }), {
      clientX: 20,
      clientY: 20,
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(dialog, { clientX: 0, clientY: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
