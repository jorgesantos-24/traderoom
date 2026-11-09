import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal built on the native <dialog>: focus trap, Esc to close and inert background
 * come from the browser. Focus returns to whatever opened it.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      const opener = document.activeElement as HTMLElement | null;
      el.showModal();
      return () => opener?.focus();
    }
    if (!open && el.open) el.close();
    return undefined;
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto ${wide ? 'w-[min(900px,calc(100vw-2rem))]' : 'w-[min(440px,calc(100vw-2rem))]'} panel rounded-card border border-border p-0 text-text shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] backdrop:bg-bg/70 backdrop:backdrop-blur-sm`}
    >
      {open && (
        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <h2 id={titleId} className="text-xl font-bold tracking-tight">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
