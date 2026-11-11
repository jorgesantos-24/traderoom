import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  BR_STATES,
  KYC_DOC_TYPES,
  KYC_MAX_FILE_BYTES,
  KycSubmitInput,
  requiredKycFiles,
  type KycDocType,
  type KycFileKind,
  type KycStateView,
  type KycSubmitRequest,
} from '@traderoom/shared';
import { AppShell } from '../components/AppShell';
import { Button, Card, cx, ErrorState, Field, FormMessage, LoadingState } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDateTime, KYC_DOC_LABEL, KYC_FILE_LABEL } from '../lib/format';
import { Link } from '../lib/router';

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Longest side after shrinking: enough to read a document, small enough to upload on mobile data. */
const MAX_SIDE = 1600;

/** Re-encodes a photo as JPEG (also drops EXIF data such as GPS position). */
async function shrinkImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Não foi possível ler esta imagem. Envie uma foto JPG ou PNG.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Não foi possível processar esta imagem.');
  if (blob.size > KYC_MAX_FILE_BYTES) throw new Error('Imagem muito grande. Tente outra foto.');
  return blob;
}

type FormState = Required<Omit<KycSubmitRequest, 'docType' | 'state'>> & { docType: KycDocType; state: string };

const EMPTY: FormState = {
  fullName: '',
  cpf: '',
  birthDate: '',
  phone: '',
  zip: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
  docType: 'RG',
};

function fromState(s: KycStateView): FormState {
  const sub = s.submission;
  if (!sub) return EMPTY;
  return {
    fullName: sub.fullName ?? '',
    cpf: sub.cpf ?? '',
    birthDate: sub.birthDate ?? '',
    phone: sub.phone ?? '',
    zip: sub.zip ?? '',
    street: sub.street ?? '',
    number: sub.number ?? '',
    complement: sub.complement ?? '',
    district: sub.district ?? '',
    city: sub.city ?? '',
    state: sub.state ?? '',
    docType: sub.docType ?? 'RG',
  };
}

export function VerificationPage() {
  const [state, setState] = useState<KycStateView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    api.kyc().then(setState, (err: unknown) => setLoadError(errMsg(err, 'Não foi possível carregar a verificação.')));
  };
  useEffect(load, []);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-xl font-semibold">Verificação de conta</h1>
        <p className="mb-4 text-sm text-muted">
          Para sacar da conta real, confirme sua identidade. A análise é feita pela nossa equipe.
        </p>
        {loadError && <ErrorState message={loadError} onRetry={load} />}
        {!state && !loadError && <LoadingState label="Carregando…" />}
        {state?.status === 'approved' && <Approved state={state} />}
        {state?.status === 'pending' && <Pending state={state} />}
        {(state?.status === 'none' || state?.status === 'rejected') && <KycForm initial={state} onDone={setState} />}
      </div>
    </AppShell>
  );
}

function StatusCard({ tone, title, children }: { tone: 'up' | 'brand'; title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-3 p-8 text-center" data-testid="kyc-status">
      <div
        className={cx(
          'flex size-14 items-center justify-center rounded-full',
          tone === 'up' ? 'bg-up/15 text-up' : 'bg-brand/15 text-brand',
        )}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {tone === 'up' ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />}
        </svg>
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function Approved({ state }: { state: KycStateView }) {
  return (
    <StatusCard tone="up" title="Conta verificada">
      <p className="text-sm text-muted">
        {state.submission?.reviewedAt ? `Aprovada em ${formatDateTime(state.submission.reviewedAt)}. ` : ''}
        Saques via Pix estão liberados.
      </p>
      <Link href="/traderoom" className="text-sm font-semibold text-brand hover:underline">
        Voltar para a negociação
      </Link>
    </StatusCard>
  );
}

function Pending({ state }: { state: KycStateView }) {
  return (
    <StatusCard tone="brand" title="Documentos em análise">
      <p className="max-w-md text-sm text-muted">
        {state.submission?.submittedAt ? `Enviados em ${formatDateTime(state.submission.submittedAt)}. ` : ''}
        Avisaremos aqui assim que a análise terminar. Enquanto isso, você pode continuar usando a conta demo.
      </p>
    </StatusCard>
  );
}

function KycForm({ initial, onDone }: { initial: KycStateView; onDone(s: KycStateView): void }) {
  const [form, setForm] = useState<FormState>(() => fromState(initial));
  // Photos from a rejected submission don't carry over: a new draft starts empty.
  const [uploaded, setUploaded] = useState<KycFileKind[]>(initial.submission?.status === 'draft' ? initial.submission.files : []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rejected = initial.status === 'rejected' && initial.submission?.status === 'rejected' ? initial.submission : null;

  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const needed = requiredKycFiles(form.docType);
  const missing = needed.filter((k) => !uploaded.includes(k));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const input: KycSubmitRequest = { ...form, complement: form.complement.trim() || undefined } as KycSubmitRequest;
    const parsed = KycSubmitInput.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        next[key] ??= issue.message;
      }
      setErrors(next);
      setError('Confira os campos destacados.');
      return;
    }
    setErrors({});
    if (missing.length > 0) {
      setError(`Envie: ${missing.map((k) => KYC_FILE_LABEL[k].toLowerCase()).join(', ')}.`);
      return;
    }
    setBusy(true);
    try {
      onDone(await api.submitKyc(input));
    } catch (err) {
      setError(errMsg(err, 'Não foi possível enviar. Tente novamente.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      {rejected && (
        <FormMessage tone="error">
          <strong>Verificação recusada.</strong> {rejected.rejectReason} Corrija e envie novamente.
        </FormMessage>
      )}

      <Section title="Dados pessoais" step={1}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            className="sm:col-span-2"
            label="Nome completo (como no documento)"
            autoComplete="name"
            value={form.fullName}
            onChange={set('fullName')}
            error={errors.fullName}
          />
          <Field label="CPF" inputMode="numeric" placeholder="000.000.000-00" value={form.cpf} onChange={set('cpf')} error={errors.cpf} />
          <Field
            label="Data de nascimento"
            type="date"
            autoComplete="bday"
            value={form.birthDate}
            onChange={set('birthDate')}
            error={errors.birthDate}
          />
          <Field
            label="Celular"
            type="tel"
            autoComplete="tel-national"
            placeholder="(11) 90000-0000"
            value={form.phone}
            onChange={set('phone')}
            error={errors.phone}
          />
        </div>
      </Section>

      <Section title="Endereço" step={2}>
        <div className="grid gap-3 sm:grid-cols-6">
          <Field
            className="sm:col-span-2"
            label="CEP"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="00000-000"
            value={form.zip}
            onChange={set('zip')}
            error={errors.zip}
          />
          <Field
            className="sm:col-span-4"
            label="Rua"
            autoComplete="address-line1"
            value={form.street}
            onChange={set('street')}
            error={errors.street}
          />
          <Field className="sm:col-span-2" label="Número" value={form.number} onChange={set('number')} error={errors.number} />
          <Field
            className="sm:col-span-4"
            label="Complemento (opcional)"
            value={form.complement}
            onChange={set('complement')}
            error={errors.complement}
          />
          <Field className="sm:col-span-3" label="Bairro" value={form.district} onChange={set('district')} error={errors.district} />
          <Field
            className="sm:col-span-2"
            label="Cidade"
            autoComplete="address-level2"
            value={form.city}
            onChange={set('city')}
            error={errors.city}
          />
          <Select className="sm:col-span-1" label="UF" value={form.state} onChange={set('state')} error={errors.state}>
            <option value="">—</option>
            {BR_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
      </Section>

      <Section title="Documento com foto" step={3}>
        <div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Tipo de documento">
          {KYC_DOC_TYPES.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={form.docType === d}
              onClick={() => setForm((f) => ({ ...f, docType: d }))}
              className={cx(
                'rounded-control border px-3 py-1.5 text-sm',
                form.docType === d ? 'border-brand bg-brand/10 text-text' : 'border-border text-muted hover:text-text',
              )}
            >
              {KYC_DOC_LABEL[d]}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {needed.map((kind) => (
            <PhotoSlot key={kind} kind={kind} done={uploaded.includes(kind)} onUploaded={(s) => setUploaded(s.submission?.files ?? [])} />
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Fotos nítidas, sem reflexo e com o documento inteiro visível. Na selfie, segure o documento ao lado do rosto. JPG, PNG ou WEBP.
        </p>
      </Section>

      {error && <FormMessage tone="error">{error}</FormMessage>}
      <div className="flex flex-col items-end gap-2">
        <Button type="submit" busy={busy} className="px-6">
          Enviar para análise
        </Button>
        <p className="text-xs text-muted">Seus dados são usados apenas para confirmar sua identidade e cumprir obrigações legais.</p>
      </div>
    </form>
  );
}

function Section({ title, step, children }: { title: string; step: number; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span className="flex size-6 items-center justify-center rounded-full bg-field text-xs text-muted">{step}</span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

function Select({
  label,
  error,
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string }) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <select
        id={id}
        {...rest}
        aria-invalid={error ? true : undefined}
        className={cx(
          'rounded-control border bg-field px-2 py-2 text-sm text-text',
          error ? 'border-down' : 'border-border focus:border-brand',
        )}
      >
        {children}
      </select>
      {error && <p className="text-xs text-down">{error}</p>}
    </div>
  );
}

function PhotoSlot({ kind, done, onUploaded }: { kind: KycFileKind; done: boolean; onUploaded(s: KycStateView): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await shrinkImage(file);
      const state = await api.uploadKycFile(kind, blob);
      setPreview(URL.createObjectURL(blob));
      onUploaded(state);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Falha no envio.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        data-testid={`kyc-slot-${kind}`}
        className={cx(
          'relative flex aspect-[4/3] flex-col items-center justify-center gap-1 overflow-hidden rounded-control border-2 border-dashed text-sm',
          done ? 'border-up/60' : 'border-border hover:border-muted',
          error && 'border-down',
        )}
      >
        {preview && <img src={preview} alt="" className="absolute inset-0 size-full object-cover opacity-60" />}
        <span className="relative font-medium">{KYC_FILE_LABEL[kind]}</span>
        <span className={cx('relative text-xs', done ? 'text-up' : 'text-muted')}>
          {busy ? 'Enviando…' : done ? 'Enviada ✓ (toque para trocar)' : 'Toque para enviar'}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        capture={kind === 'selfie' ? 'user' : undefined}
        className="sr-only"
        tabIndex={-1}
        aria-label={KYC_FILE_LABEL[kind]}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {error && <p className="text-xs text-down">{error}</p>}
    </div>
  );
}
