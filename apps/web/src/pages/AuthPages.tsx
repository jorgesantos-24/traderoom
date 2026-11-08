import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ForgotInput, PASSWORD_MIN_LENGTH, RegisterInput, ResetInput, TokenSchema } from '@traderoom/shared';
import type { z } from 'zod';
import { Button, Card, Field, FormMessage } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Link, navigate, safeNext, useLocation } from '../lib/router';

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

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center">
          <img src="/brand/kyden-logo.png" alt="Kyden Financial Markets" className="h-14 w-auto" />
        </div>
        <Card className="p-6">
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </Card>
        {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
      </div>
    </main>
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
        <Field
          label="Senha"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <Button type="submit" busy={busy} className="w-full">
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
        <Field
          label="Senha"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set('password')}
          error={errors.password}
          hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`}
        />
        <Field
          label="Confirmar senha"
          type="password"
          autoComplete="new-password"
          required
          value={form.confirm}
          onChange={set('confirm')}
          error={errors.confirm}
        />
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <Button type="submit" busy={busy} className="w-full">
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
          <Button type="submit" busy={busy} className="w-full">
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
        <Field
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`}
        />
        <Field
          label="Confirmar nova senha"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        {errors.token && <FormMessage tone="error">{errors.token}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <Button type="submit" busy={busy} className="w-full">
          Salvar nova senha
        </Button>
      </form>
    </AuthLayout>
  );
}
