import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ForgotInput, PASSWORD_MIN_LENGTH, RegisterInput, ResetInput, TokenSchema } from '@traderoom/shared';
import type { z } from 'zod';
import { Button, Card, Field, FormMessage } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Link, navigate, safeNext, useLocation } from '../lib/router';
import { requestSplash } from '../lib/splash';

type Errors = Record<string, string | undefined>;

/** First message per field from a zod error, for inline display. */
function fieldErrors(err: z.ZodError): Errors {
  const out: Errors = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '_');
    out[key] ??= issue.message;
  }
  return out;
}

const apiMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Algo deu errado. Tente novamente.');

const HIGHLIGHTS: Array<{ title: string; text: string; icon: ReactNode }> = [
  {
    title: 'Mercado 24/7',
    text: 'Cripto e OTC a qualquer hora',
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </>
    ),
  },
  {
    title: 'Pix na hora',
    text: 'Depósitos e saques em reais',
    icon: <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7z" />,
  },
  {
    title: 'Conta demo',
    text: 'US$ 10.000 para treinar',
    icon: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M3 10h18M16 14.5h2" />
      </>
    ),
  },
];

/** Decorative rising chart with candles behind it; it draws itself once. */
function HeroChart() {
  const candles = [
    [40, 150, 175, 135, 185],
    [80, 160, 140, 130, 168],
    [120, 140, 150, 125, 158],
    [160, 150, 118, 108, 156],
    [200, 120, 128, 104, 134],
    [240, 126, 96, 88, 130],
    [280, 98, 104, 84, 112],
    [320, 104, 72, 64, 108],
    [360, 74, 60, 50, 82],
    [400, 62, 40, 30, 66],
  ] as const;
  return (
    <svg viewBox="0 0 440 210" className="h-auto w-full" aria-hidden="true">
      <defs>
        <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-brand)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--color-brand)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hero-stroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--color-brand-2)" />
          <stop offset="1" stopColor="var(--color-brand)" />
        </linearGradient>
      </defs>
      {[50, 100, 150].map((y) => (
        <line key={y} x1="0" x2="440" y1={y} y2={y} stroke="rgb(255 255 255 / 0.05)" strokeDasharray="3 6" />
      ))}
      {candles.map(([x, open, close, high, low]) => {
        const up = close < open;
        return (
          <g key={x} opacity="0.55">
            <line x1={x} x2={x} y1={high} y2={low} stroke={up ? 'var(--color-up)' : 'var(--color-down)'} strokeWidth="1.5" />
            <rect
              x={x - 6}
              y={Math.min(open, close)}
              width="12"
              height={Math.max(3, Math.abs(open - close))}
              rx="2"
              fill={up ? 'var(--color-up)' : 'var(--color-down)'}
            />
          </g>
        );
      })}
      <path
        d="M0 175 L40 165 L80 150 L120 145 L160 125 L200 125 L240 100 L280 100 L320 75 L360 64 L400 46 L440 30 L440 210 L0 210 Z"
        fill="url(#hero-area)"
      />
      <path
        className="hero-line"
        d="M0 175 L40 165 L80 150 L120 145 L160 125 L200 125 L240 100 L280 100 L320 75 L360 64 L400 46 L440 30"
        fill="none"
        stroke="url(#hero-stroke)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="hero-dot" cx="436" cy="31" r="5" fill="var(--color-brand)" />
      <circle cx="436" cy="31" r="3" fill="#fff" />
    </svg>
  );
}

/** Left half on large screens: the brand, a headline and what the platform offers. */
function AuthHero() {
  return (
    <aside className="relative hidden h-dvh min-h-[560px] flex-col justify-between gap-6 overflow-hidden border-r border-border px-10 py-8 lg:sticky lg:top-0 lg:flex xl:px-14 xl:py-10">
      <img src="/brand/kyden-logo.png" alt="Kyden Financial Markets" className="relative h-10 w-auto self-start xl:h-12" />
      <div className="relative max-w-xl">
        <p className="fade-up mb-4 inline-flex items-center gap-2 rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-xs font-medium text-brand">
          <span className="size-1.5 animate-pulse rounded-full bg-brand" />
          Mercados abertos agora
        </p>
        <h2
          className="fade-up text-4xl leading-[1.08] font-bold tracking-tight [@media(min-height:820px)]:xl:text-5xl"
          style={{ animationDelay: '80ms' }}
        >
          Opere os mercados com <span className="text-gradient">velocidade de verdade.</span>
        </h2>
        <p className="fade-up mt-4 max-w-md text-base text-muted" style={{ animationDelay: '160ms' }}>
          Ordens em segundos, gráficos ao vivo e dinheiro entrando e saindo por Pix.
        </p>
        <div
          className="panel fade-up mt-6 max-w-md rounded-card border border-border p-4 [@media(max-height:700px)]:max-w-sm"
          style={{ animationDelay: '240ms' }}
        >
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold text-text">BTC/USDT</span>
            <span className="rounded-full bg-up/15 px-2 py-0.5 font-semibold text-up">▲ Alta</span>
          </div>
          <HeroChart />
        </div>
      </div>
      <ul className="relative grid grid-cols-3 gap-3">
        {HIGHLIGHTS.map((h, i) => (
          <li
            key={h.title}
            className="fade-up rounded-control border border-border bg-surface/60 p-3"
            style={{ animationDelay: `${320 + i * 80}ms` }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="mb-2 size-5 text-brand"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {h.icon}
            </svg>
            <div className="text-sm font-semibold">{h.title}</div>
            <div className="text-xs text-muted">{h.text}</div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <div className="relative grid min-h-full lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,1fr)]">
      <div className="auth-backdrop" />
      <AuthHero />
      <main className="relative flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex items-center justify-center lg:hidden">
            <img src="/brand/kyden-logo.png" alt="Kyden Financial Markets" className="h-12 w-auto" />
          </div>
          <Card className="fade-up p-6 sm:p-8">
            <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight outline-none">
              {title}
            </h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </Card>
          {footer && <div className="mt-5 text-center text-sm text-muted">{footer}</div>}
          <p className="mt-8 text-center text-[11px] leading-relaxed text-muted/70">
            Negociar envolve risco. Opere apenas com valores que você pode perder.
          </p>
        </div>
      </main>
    </div>
  );
}

/** Password input with a show/hide toggle. */
function PasswordField(props: Omit<Parameters<typeof Field>[0], 'type' | 'trailing'>) {
  const [show, setShow] = useState(false);
  return (
    <Field
      {...props}
      type={show ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
          aria-pressed={show}
          className="grid size-9 place-items-center rounded-control text-muted hover:bg-border/50 hover:text-text"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
            {show && <path d="M4 4l16 16" />}
          </svg>
        </button>
      }
    />
  );
}

const linkCls = 'font-medium text-brand hover:underline';

export function LoginPage() {
  const { login, state } = useAuth();
  const { search } = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = safeNext(search.get('next'));

  const notice =
    state.status === 'anon' && state.expired
      ? 'Sua sessão expirou. Entre novamente.'
      : search.get('registered')
        ? 'Conta criada. Entre para continuar.'
        : search.get('reset')
          ? 'Senha alterada. Entre com a nova senha.'
          : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Informe e-mail e senha.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      requestSplash();
      navigate(next, { replace: true });
    } catch (err) {
      setError(apiMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Acesse sua conta para negociar."
      footer={
        <>
          Não tem conta?{' '}
          <Link href="/register" className={linkCls}>
            Criar conta
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        {notice && <FormMessage tone="info">{notice}</FormMessage>}
        <Field label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField
          label="Senha"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <Button type="submit" busy={busy} className="mt-1 w-full py-3 text-base">
          Entrar
        </Button>
        <Link href="/forgot" className={`${linkCls} self-center text-sm`}>
          Esqueci minha senha
        </Link>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = RegisterInput.safeParse(form);
    const errs: Errors = parsed.success ? {} : fieldErrors(parsed.error);
    if (form.confirm !== form.password) errs.confirm = 'As senhas não conferem.';
    setErrors(errs);
    if (!parsed.success || errs.confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.register(parsed.data.name, parsed.data.email, parsed.data.password);
      navigate('/login?registered=1', { replace: true });
    } catch (err) {
      setError(apiMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Criar conta"
      footer={
        <>
          Já tem conta?{' '}
          <Link href="/login" className={linkCls}>
            Entrar
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <Field label="Nome" autoComplete="name" required value={form.name} onChange={set('name')} error={errors.name} />
        <Field label="E-mail" type="email" autoComplete="email" required value={form.email} onChange={set('email')} error={errors.email} />
        <PasswordField
          label="Senha"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set('password')}
          error={errors.password}
          hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`}
        />
        <PasswordField
          label="Confirmar senha"
          autoComplete="new-password"
          required
          value={form.confirm}
          onChange={set('confirm')}
          error={errors.confirm}
        />
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <Button type="submit" busy={busy} className="mt-1 w-full py-3 text-base">
          Criar conta
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = ForgotInput.safeParse({ email });
    setFieldError(parsed.success ? undefined : fieldErrors(parsed.error).email);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      await api.forgot(parsed.data.email);
      setSent(true);
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Recuperar senha"
      subtitle="Enviaremos um link para você criar uma nova senha."
      footer={
        <Link href="/login" className={linkCls}>
          Voltar para o login
        </Link>
      }
    >
      {sent ? (
        <FormMessage tone="success">
          Se este e-mail estiver cadastrado, você receberá um link em instantes. Ele vale por 30 minutos.
        </FormMessage>
      ) : (
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <Field
            label="E-mail"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldError}
          />
          {error && <FormMessage tone="error">{error}</FormMessage>}
          <Button type="submit" busy={busy} className="mt-1 w-full py-3 text-base">
            Enviar link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPage() {
  const { search } = useLocation();
  const token = search.get('token') ?? '';
  const tokenOk = TokenSchema.safeParse(token).success;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = ResetInput.safeParse({ token, password });
    const errs: Errors = parsed.success ? {} : fieldErrors(parsed.error);
    if (confirm !== password) errs.confirm = 'As senhas não conferem.';
    setErrors(errs);
    if (!parsed.success || errs.confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.reset(parsed.data.token, parsed.data.password);
      navigate('/login?reset=1', { replace: true });
    } catch (err) {
      setError(apiMessage(err));
      setBusy(false);
    }
  };

  const footer = (
    <Link href="/forgot" className={linkCls}>
      Pedir um novo link
    </Link>
  );

  if (!tokenOk) {
    return (
      <AuthLayout title="Link inválido" footer={footer}>
        <FormMessage tone="error">Este link de redefinição é inválido ou está incompleto. Peça um novo.</FormMessage>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Nova senha" footer={footer}>
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <PasswordField
          label="Nova senha"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`}
        />
        <PasswordField
          label="Confirmar nova senha"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        {errors.token && <FormMessage tone="error">{errors.token}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <Button type="submit" busy={busy} className="mt-1 w-full py-3 text-base">
          Salvar nova senha
        </Button>
      </form>
    </AuthLayout>
  );
}
