import { useEffect, useState } from 'react';
import { useUser } from '../lib/auth';
import { clearSplash } from '../lib/splash';
import { useSessionData } from '../lib/session-data';
import { cx } from './ui';

/** Shortest time the welcome screen stays up, so it reads as a moment and not a flash. */
const MIN_MS = 2200;
const FADE_MS = 450;

/** Branded full-screen loader: logo in a spinning ring, a chart line drawing itself, a progress bar. */
export function SplashScreen({
  message,
  progress,
  greeting,
  leaving = false,
}: {
  message: string;
  progress?: number;
  greeting?: string;
  leaving?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden bg-bg px-6 transition-opacity',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      data-testid="splash"
    >
      <div className="auth-backdrop" />
      <div className="relative flex flex-col items-center text-center">
        <div className="relative size-32">
          <div className="splash-ring absolute inset-0 rounded-full" />
          <div className="absolute inset-[6px] rounded-full bg-bg" />
          <div className="splash-glow absolute inset-6 rounded-full" />
          <img
            src="/brand/kyden-mark.png"
            alt=""
            className="absolute inset-[30px] rounded-2xl shadow-[0_10px_30px_-10px_rgb(0_216_232/0.7)]"
          />
        </div>

        <img src="/brand/kyden-logo.png" alt="Kyden" className="fade-up mt-8 h-10 w-auto" />

        {greeting && (
          <p className="fade-up mt-5 text-lg font-semibold text-text" style={{ animationDelay: '150ms' }}>
            {greeting}
          </p>
        )}

        <svg viewBox="0 0 240 48" className="mt-5 h-12 w-60" aria-hidden="true">
          <defs>
            <linearGradient id="splash-line" x1="0" x2="1">
              <stop offset="0" stopColor="var(--color-brand)" stopOpacity="0.2" />
              <stop offset="1" stopColor="var(--color-brand)" />
            </linearGradient>
          </defs>
          <path
            className="splash-line"
            d="M2 40 L28 32 L46 36 L70 22 L92 28 L116 14 L138 20 L160 10 L184 18 L208 6 L236 4"
            fill="none"
            stroke="url(#splash-line)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <div className="mt-4 h-1.5 w-64 overflow-hidden rounded-full bg-field">
          {progress === undefined ? (
            <div className="splash-indeterminate brand-gradient h-full w-1/3 rounded-full" />
          ) : (
            <div
              className="brand-gradient h-full rounded-full shadow-[0_0_12px_var(--color-brand)] transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
            />
          )}
        </div>
        <p className="mt-3 h-5 text-sm text-muted" key={message}>
          <span className="fade-up inline-block">{message}</span>
        </p>
      </div>
      <p className="absolute bottom-6 text-xs text-muted/70">Conexão segura · Dados em tempo real</p>
    </div>
  );
}

/**
 * Welcome screen right after login: stays over the app while the balances, the asset list
 * and the page code load, at least MIN_MS, then fades out.
 */
export function LoginSplash() {
  const user = useUser();
  const { wallet, catalog } = useSessionData();
  const [elapsed, setElapsed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setElapsed(true), MIN_MS);
    return () => clearTimeout(t);
  }, []);

  const walletDone = wallet.status !== 'loading';
  const catalogDone = catalog.status !== 'loading';
  const ready = walletDone && catalogDone && elapsed;

  useEffect(() => {
    if (!ready) return;
    const a = setTimeout(() => setLeaving(true), 350);
    const b = setTimeout(() => {
      setGone(true);
      clearSplash();
    }, 350 + FADE_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [ready]);

  if (gone) return null;
  const progress = ready ? 100 : 25 + (walletDone ? 30 : 0) + (catalogDone ? 30 : 0);
  const message = ready
    ? 'Tudo pronto!'
    : !walletDone
      ? 'Carregando seus saldos…'
      : !catalogDone
        ? 'Abrindo os gráficos em tempo real…'
        : 'Preparando sua sala de operações…';
  const first = user.name.trim().split(/\s+/)[0];
  return <SplashScreen message={message} progress={progress} greeting={first ? `Bem-vindo, ${first}` : 'Bem-vindo'} leaving={leaving} />;
}
