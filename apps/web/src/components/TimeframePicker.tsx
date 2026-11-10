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
        className={cx(
          'flex size-[34px] items-center justify-center rounded-[3px] border bg-[#12171e]/80 text-[13px] font-bold hover:border-[#5a616b] hover:text-white',
          open ? 'border-[#5a616b] text-white' : 'border-[#3a4049] text-[#d5d7da]',
        )}
      >
        {value}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Intervalo do gráfico"
          className="absolute bottom-0 left-full z-40 ml-2 flex min-w-[64px] flex-col rounded-control border border-border bg-field p-1 shadow-xl"
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
                tf === value ? 'bg-up/15 text-up' : 'text-muted hover:bg-surface hover:text-text',
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
