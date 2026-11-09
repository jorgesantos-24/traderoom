import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'up' | 'down';

const VARIANTS: Record<Variant, string> = {
  // Dark text on the bright fills keeps contrast above AA (≥ 4.5:1).
  primary: 'brand-gradient text-bg glow hover:brightness-110',
  secondary: 'border border-border bg-field text-text hover:border-muted hover:bg-field/70',
  ghost: 'text-muted hover:text-text hover:bg-field',
  up: 'bg-[linear-gradient(135deg,#34d672,#16a34a)] text-bg shadow-[0_10px_28px_-12px_var(--color-up)] hover:brightness-110',
  down: 'bg-[linear-gradient(135deg,#ff6b5e,#dc2b2b)] text-bg shadow-[0_10px_28px_-12px_var(--color-down)] hover:brightness-110',
};

export function Button({
  variant = 'primary',
  className,
  busy = false,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-semibold',
        'transition-[filter,background-color,border-color,color,transform] duration-150 active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100',
        VARIANTS[variant],
        className,
      )}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={cx('panel rounded-card border border-border', className)}>
      {children}
    </section>
  );
}

export function Spinner({ small = false, label }: { small?: boolean; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-2 text-muted">
      <span
        aria-hidden="true"
        className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'size-3.5' : 'size-5')}
      />
      {label && <span className="text-sm">{label}</span>}
    </span>
  );
}

export function LoadingState({ label = 'Carregando…', className }: { label?: string; className?: string }) {
  return (
    <div className={cx('flex items-center justify-center p-8', className)}>
      <Spinner label={label} />
    </div>
  );
}

export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center gap-3 p-8 text-center', className)}>
      <p className="text-sm text-text">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, className }: { title: string; hint?: string; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-1 p-8 text-center', className)}>
      <p className="text-sm font-medium text-text">{title}</p>
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  className,
  trailing,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: string; trailing?: ReactNode }) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          {...input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            'w-full rounded-control border bg-field px-3 py-2.5 text-base text-text transition-[border-color,box-shadow] sm:text-sm',
            'placeholder:text-muted/70 focus:outline-none focus:ring-3',
            error ? 'border-down focus:ring-down/20' : 'border-border hover:border-muted/60 focus:border-brand focus:ring-brand/15',
            trailing ? 'pr-11' : null,
          )}
        />
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-xs text-down">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormMessage({ tone, children }: { tone: 'error' | 'info' | 'success'; children: ReactNode }) {
  const color =
    tone === 'error'
      ? 'border-down/40 bg-down/10 text-down'
      : tone === 'success'
        ? 'border-up/40 bg-up/10 text-up'
        : 'border-brand/25 bg-brand/[0.07] text-text';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-control border px-3 py-2.5 text-sm', color)}>
      {children}
    </div>
  );
}

export { cx };
