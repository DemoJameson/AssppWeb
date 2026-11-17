import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A native modal dialog. The browser owns focus containment, Esc/back
 * dismissal, top-layer rendering and returning focus to the invoker.
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // `closedby` is progressive enhancement for click/tap-outside dismissal.
    // Older browsers get the same behaviour from the pointer fallback below.
    dialog.setAttribute('closedby', 'any');

    let pressedOutside = false;
    const isOutside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = isOutside(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pressedOutside && isOutside(event)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={open ? titleId : undefined}
      className="m-auto w-[calc(100%-2rem)] max-w-sm overflow-y-auto overscroll-contain rounded-[28px] border border-white/70 bg-white/95 p-6 text-gray-900 shadow-[0_24px_70px_-20px_rgba(15,23,42,0.45)] backdrop:bg-gray-950/45 backdrop:backdrop-blur-sm dark:border-white/10 dark:bg-gray-900/95 dark:text-white dark:shadow-black/60"
      style={{
        maxHeight:
          'calc(100dvh - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      {open && (
        <>
          <h3 id={titleId} className="mb-4 text-lg font-semibold tracking-tight">
            {title}
          </h3>
          {children}
        </>
      )}
    </dialog>
  );
}
