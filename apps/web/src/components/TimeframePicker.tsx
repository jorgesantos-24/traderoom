import { useEffect, useRef, useState } from 'react';
import type { CandleInterval } from '@traderoom/shared';
import { cx } from './ui';

/** Small chart-corner button showing the candle interval; opens a menu to pick another. */
export function TimeframePicker({
  value,
  options,
  onChange,
}: {
  value: CandleInterval;
  options: readonly CandleInterval[];
  onChange(tf: CandleInterval): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Intervalo do gráfico: ${value}`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-0.5 rounded-control px-1.5 py-1 text-sm font-semibold text-text hover:bg-field"
      >
        {value}
        <svg aria-hidden="true" viewBox="0 0 24 24" className={cx('size-3.5 text-muted transition-transform', open && 'rotate-180')}>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Intervalo do gráfico"
          className="absolute top-0 left-full z-40 ml-2 flex min-w-[64px] flex-col rounded-control border border-border bg-field p-1 shadow-xl"
        >
          {options.map((tf) => (
            <button
              key={tf}
              type="button"
              role="menuitemradio"
              aria-checked={tf === value}
              onClick={() => {
                onChange(tf);
                setOpen(false);
              }}
              className={cx(
                'rounded px-2.5 py-1.5 text-left text-xs font-semibold',
                tf === value ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface hover:text-text',
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
