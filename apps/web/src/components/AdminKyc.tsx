import { useCallback, useState } from 'react';
import { requiredKycFiles, type AdminKycView } from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import { formatDateTime, KYC_DOC_LABEL, KYC_FILE_LABEL, KYC_STATUS_LABEL } from '../lib/format';
import { usePaged } from '../lib/use-paged';
import { Dialog } from './Dialog';
import { PagedFooter } from './PagedFooter';
import { Button, Card, cx, EmptyState, ErrorState, Field, FormMessage, LoadingState } from './ui';

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const maskCpf = (c: string | null) =>
  c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : (c ?? '—');
const maskPhone = (p: string | null) => (p ? `(${p.slice(0, 2)}) ${p.slice(2, -4)}-${p.slice(-4)}` : '—');
const maskZip = (z: string | null) => (z && z.length === 8 ? `${z.slice(0, 5)}-${z.slice(5)}` : (z ?? '—'));
const formatBirth = (d: string | null) => (d ? d.split('-').reverse().join('/') : '—');

const STATUS_TONE: Record<AdminKycView['status'], string> = {
  draft: 'text-muted',
  pending: 'text-brand',
  approved: 'text-up',
  rejected: 'text-down',
};

/** Identity checks sent by clients. Approving unlocks Pix deposits and withdrawals for that account. */
export function KycTab({ onNotice }: { onNotice(m: string): void }) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const fetchPage = useCallback((cursor?: string) => api.admin.kycList({ status: filter, cursor, limit: 50 }), [filter]);
  const list = usePaged<AdminKycView>(fetchPage, `kyc:${filter}`);
  const [open, setOpen] = useState<AdminKycView | null>(null);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-sm text-muted">Confira se o rosto da selfie e os dados batem com o documento antes de aprovar.</p>
        <div className="flex gap-1">
          {(['pending', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cx('rounded-control px-3 py-1 text-sm', filter === f ? 'bg-field text-text' : 'text-muted hover:text-text')}
            >
              {f === 'pending' ? 'Pendentes' : 'Todas'}
            </button>
          ))}
        </div>
      </div>
      {list.status === 'loading' && <LoadingState label="Carregando verificações…" />}
      {list.status === 'error' && <ErrorState message={list.error ?? ''} onRetry={list.reload} />}
      {list.status === 'ready' && list.items.length === 0 && (
        <EmptyState title={filter === 'pending' ? 'Nenhuma verificação pendente' : 'Nenhuma verificação'} />
      )}
      {list.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Verificações de identidade</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Enviada
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Cliente
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Nome no documento
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Documento
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((k) => (
                <tr key={k.id} className="border-t border-border align-top" data-testid="kyc-row">
                  <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{k.submittedAt ? formatDateTime(k.submittedAt) : '—'}</td>
                  <td className="px-4 py-2">
                    <div>{k.userName}</div>
                    <div className="text-xs text-muted">{k.userEmail}</div>
                  </td>
                  <td className="px-4 py-2">
                    <div>{k.fullName ?? '—'}</div>
                    <div className="text-xs text-muted">CPF {maskCpf(k.cpf)}</div>
                  </td>
                  <td className="px-4 py-2">{k.docType ? KYC_DOC_LABEL[k.docType] : '—'}</td>
                  <td className={cx('px-4 py-2', STATUS_TONE[k.status])}>
                    <div>{KYC_STATUS_LABEL[k.status]}</div>
                    {k.rejectReason && <div className="text-xs text-muted">{k.rejectReason}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <Button variant={k.status === 'pending' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => setOpen(k)}>
                      {k.status === 'pending' ? 'Analisar' : 'Ver'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedFooter paged={list} />

      <ReviewDialog
        submission={open}
        onClose={() => setOpen(null)}
        onDecided={(updated) => {
          list.patch((x) => (x.id === updated.id ? updated : x));
          setOpen(null);
          onNotice(`Verificação de ${updated.userEmail}: ${KYC_STATUS_LABEL[updated.status].toLowerCase()}.`);
        }}
      />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function ReviewDialog({
  submission: k,
  onClose,
  onDecided,
}: {
  submission: AdminKycView | null;
  onClose(): void;
  onDecided(s: AdminKycView): void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);

  const close = () => {
    setError(null);
    setRejecting(false);
    setReason('');
    setZoom(null);
    onClose();
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!k) return;
    setBusy(decision);
    setError(null);
    try {
      const updated = await api.admin.kycDecision(k.id, decision, decision === 'reject' ? reason : undefined);
      setRejecting(false);
      setReason('');
      onDecided(updated);
    } catch (err) {
      setError(errMsg(err, 'Não foi possível concluir a ação.'));
    } finally {
      setBusy(null);
    }
  };

  const files = k?.docType ? requiredKycFiles(k.docType).filter((f) => k.files.includes(f)) : (k?.files ?? []);

  return (
    <Dialog open={k !== null} title="Verificação de identidade" onClose={close} wide>
      {k && (
        <>
          <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
            <dl>
              <Row label="Conta" value={`${k.userName} · ${k.userEmail}`} />
              <Row label="Nome completo" value={k.fullName ?? '—'} />
              <Row label="CPF" value={maskCpf(k.cpf)} />
              <Row label="Nascimento" value={formatBirth(k.birthDate)} />
              <Row label="Celular" value={maskPhone(k.phone)} />
              <Row
                label="Endereço"
                value={`${k.street ?? ''}, ${k.number ?? ''}${k.complement ? ` – ${k.complement}` : ''} · ${k.district ?? ''}`}
              />
              <Row label="Cidade" value={`${k.city ?? ''}/${k.state ?? ''} · CEP ${maskZip(k.zip)}`} />
              <Row label="Documento" value={k.docType ? KYC_DOC_LABEL[k.docType] : '—'} />
              <Row label="Status" value={KYC_STATUS_LABEL[k.status]} />
              {k.reviewedAt && <Row label="Analisada em" value={formatDateTime(k.reviewedAt)} />}
              {k.rejectReason && <Row label="Motivo da recusa" value={k.rejectReason} />}
            </dl>
            <div className="grid grid-cols-2 gap-2">
              {files.map((f) => {
                const src = api.admin.kycFileUrl(k.id, f);
                return (
                  <figure key={f} className={cx(f === 'selfie' && files.length === 3 && 'col-span-2')}>
                    <button
                      type="button"
                      onClick={() => setZoom(src)}
                      className="block w-full overflow-hidden rounded-control border border-border bg-field"
                      aria-label={`Ampliar ${KYC_FILE_LABEL[f]}`}
                    >
                      <img src={src} alt={KYC_FILE_LABEL[f]} className="h-40 w-full object-contain" />
                    </button>
                    <figcaption className="mt-1 text-xs text-muted">{KYC_FILE_LABEL[f]}</figcaption>
                  </figure>
                );
              })}
            </div>
          </div>

          {zoom && (
            <button
              type="button"
              onClick={() => setZoom(null)}
              className="rounded-control border border-border bg-field p-1"
              aria-label="Fechar imagem ampliada"
            >
              <img src={zoom} alt="Imagem ampliada" className="max-h-[70vh] w-full object-contain" />
            </button>
          )}

          {error && <FormMessage tone="error">{error}</FormMessage>}

          {k.status === 'pending' && rejecting && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void decide('reject');
              }}
            >
              <Field
                label="Motivo da recusa (o cliente vê)"
                placeholder="Ex.: foto do documento ilegível"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  Voltar
                </Button>
                <Button type="submit" variant="down" busy={busy === 'reject'} disabled={reason.trim().length < 5}>
                  Recusar verificação
                </Button>
              </div>
            </form>
          )}

          {!(k.status === 'pending' && rejecting) && (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Fechar
              </Button>
              {k.status === 'pending' && (
                <>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => setRejecting(true)}>
                    Recusar
                  </Button>
                  <Button variant="up" busy={busy === 'approve'} onClick={() => void decide('approve')}>
                    Aprovar
                  </Button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
