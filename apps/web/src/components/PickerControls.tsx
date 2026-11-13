import { cx } from './ui';

/** Search field with a magnifier, used by the asset and indicator pickers. */
export function SearchField({ value, onChange, label }: { value: string; onChange(v: string): void; label: string }) {
  return (
    <div className="relative">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        autoFocus={matchMedia('(pointer: fine)').matches}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Pesquisar"
        aria-label={label}
        className="w-full rounded-control border border-border bg-field py-2 pr-3 pl-9 text-sm text-text placeholder:text-muted focus:border-brand focus:outline-none"
      />
    </div>
  );
}

/** Star toggle for marking an item as favorite. */
export function StarButton({ on, name, onToggle }: { on: boolean; name: string; onToggle(): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remover ${name} dos favoritos` : `Adicionar ${name} aos favoritos`}
      title={on ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
      onClick={onToggle}
      className={cx(
        'flex size-8 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-field',
        on ? 'text-[#f5c542]' : 'text-muted hover:text-text',
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-[18px]"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      >
        <path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z" />
      </svg>
    </button>
  );
}
