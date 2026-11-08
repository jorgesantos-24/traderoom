import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'up' | 'down';

const VARIANTS: Record<Variant, string> = {
  // Dark text on the bright fills keeps contrast above AA (≥ 4.5:1).
  primary: 'bg-brand text-bg hover:bg-brand/90',
  secondary: 'border border-border bg-surface text-text hover:border-muted',
  ghost: 'text-muted hover:text-text hover:bg-field',
  up: 'bg-up text-bg hover:bg-up/90',
  down: 'bg-down text-bg hover:bg-down/90',
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
        'disabled:cursor-not-allowed disabled:opacity-45',
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
    <section {...rest} className={cx('rounded-card border border-border bg-surface', className)}>
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
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: string }) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          'rounded-control border bg-field px-3 py-2 text-base text-text sm:text-sm placeholder:text-muted',
          error ? 'border-down' : 'border-border focus:border-brand',
        )}
      />
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
  const color = tone === 'error' ? 'border-down/50 text-down' : tone === 'success' ? 'border-up/50 text-up' : 'border-border text-text';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-control border bg-field px-3 py-2 text-sm', color)}>
      {children}
    </div>
  );
}

export { cx };
