import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import {
  PIX_KEY_TYPES,
  withdrawalFeeCents,
  type DepositView,
  type PaymentsInfo,
  type PixKeyType,
  type WithdrawalSpeed,
} from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import {
  brlToUsdCents,
  DEPOSIT_STATUS_LABEL,
  formatBrl,
  formatDateTime,
  formatFxRate,
  formatMoney,
  formatSignedMoney,
  parseMoneyToCents,
  PIX_KEY_LABEL,
  usdToBrlCents,
  WITHDRAWAL_STATUS_LABEL,
} from '../lib/format';
import { navigate } from '../lib/router';
import { useHideBalances } from '../lib/hide-balance';
import { useSessionData } from '../lib/session-data';
import { Dialog } from './Dialog';
import { Button, cx, Field, FormMessage, LoadingState } from './ui';

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Shown instead of the form until the account is verified. */
function KycGate({ info, onClose }: { info: PaymentsInfo; onClose(): void }) {
  const pending = info.kycStatus === 'pending';
  return (
    <div className="flex flex-col gap-4" data-testid="kyc-gate">
      <FormMessage tone="info">
        {pending
          ? 'Seus documentos estão em análise. Depósitos e saques serão liberados assim que a verificação for aprovada.'
          : info.kycStatus === 'rejected'
            ? 'Sua verificação foi recusada. Veja o motivo e envie novamente para liberar depósitos e saques.'
            : 'Para depositar e sacar na conta real, primeiro verifique sua identidade. Leva poucos minutos.'}
      </FormMessage>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
        {!pending && (
          <Button
            onClick={() => {
              onClose();
              navigate('/verification');
            }}
          >
            Verificar conta
          </Button>
        )}
      </div>
    </div>
  );
}
const DEPOSIT_PRESETS = [5_000, 10_000, 25_000, 50_000, 100_000];
const POLL_MS = 4000;

/** Loads limits and the CPF on file each time a dialog opens. */
function usePaymentsInfo(open: boolean) {
  const [info, setInfo] = useState<PaymentsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInfo(null);
    setError(null);
    api.payments().then(
      (r) => !cancelled && setInfo(r.info),
      (err: unknown) => !cancelled && setError(errMsg(err, 'Não foi possível carregar.')),
    );
    return () => {
      cancelled = true;
    };
  }, [open]);
  return { info, error };
}

/** Live conversion preview between the amount typed and the other currency. */
function ConversionBox({ rate, label, value }: { rate: number | null; label: string; value: string }) {
  if (!rate) {
    return <FormMessage tone="error">Cotação do dólar indisponível no momento. Tente novamente em instantes.</FormMessage>;
  }
  return (
    <div className="rounded-control border border-border bg-field px-3 py-2" data-testid="fx-preview">
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular text-lg font-bold text-up">{value}</div>
      <div className="text-xs text-muted">Cotação: {formatFxRate(rate)}</div>
    </div>
  );
}

const centsToText = (c: number) => (c / 100).toFixed(c % 100 === 0 ? 0 : 2).replace('.', ',');

/** Pix deposit: amount (+ CPF the first time) → QR code and copia e cola → confirmation. */
export function DepositDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { refreshWallet, setAccount } = useSessionData();
  const { info, error: infoError } = usePaymentsInfo(open);
  const [amount, setAmount] = useState(centsToText(DEPOSIT_PRESETS[1] as number));
  const [cpf, setCpf] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deposit, setDeposit] = useState<DepositView | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fresh form every time it opens.
  useEffect(() => {
    if (!open) return;
    setDeposit(null);
    setQr(null);
    setError(null);
    setCopied(false);
  }, [open]);

  useEffect(() => {
    if (!deposit?.pixCode) return;
    void QRCode.toDataURL(deposit.pixCode, { margin: 1, width: 240 }).then(setQr, () => setQr(null));
  }, [deposit?.pixCode]);

  // Wait for the payment; the server checks with the gateway on each poll.
  const waitingId = open && deposit?.status === 'pending' ? deposit.id : null;
  useEffect(() => {
    if (!waitingId) return;
    const t = setInterval(() => {
      api.deposit(waitingId).then(
        (d) => {
          setDeposit(d);
          if (d.status === 'paid') {
            setAccount('real');
            void refreshWallet();
          }
        },
        () => {},
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waitingId, refreshWallet, setAccount]);

  const cents = parseMoneyToCents(amount);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info || cents === null) return;
    if (cents < info.depositMinCents || cents > info.depositMaxCents) {
      setError(`O depósito deve ser entre ${formatBrl(info.depositMinCents)} e ${formatBrl(info.depositMaxCents)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDeposit(await api.createDeposit(cents, info.cpf ? undefined : cpf));
    } catch (err) {
      setError(errMsg(err, 'Não foi possível gerar o Pix.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!deposit?.pixCode) return;
    void navigator.clipboard?.writeText(deposit.pixCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Dialog open={open} title="Depositar via Pix" onClose={onClose}>
      {infoError && <FormMessage tone="error">{infoError}</FormMessage>}
      {!info && !infoError && <LoadingState label="Carregando…" />}
      {info && !info.enabled && (
        <>
          <FormMessage tone="info">Depósitos ainda não estão disponíveis. Tente novamente mais tarde.</FormMessage>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </>
      )}

      {info?.enabled && info.kycStatus !== 'approved' && <KycGate info={info} onClose={onClose} />}
      {info?.enabled && info.kycStatus === 'approved' && !deposit && (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-wrap gap-2">
            {DEPOSIT_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(centsToText(p))}
                className={cx(
                  'rounded-control border px-3 py-1.5 text-sm font-medium',
                  cents === p ? 'border-up bg-up/10 text-up' : 'border-border text-muted hover:text-text',
                )}
              >
                {formatBrl(p)}
              </button>
            ))}
          </div>
          <Field
            label="Valor (R$)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={`Mínimo ${formatBrl(info.depositMinCents)}. Você paga em reais e o saldo entra em dólares.`}
          />
          <ConversionBox
            rate={info.depositRate}
            label="Você recebe na conta real"
            value={cents !== null && info.depositRate ? formatMoney(brlToUsdCents(cents, info.depositRate)) : '—'}
          />
          {info.cpf ? (
            <p className="text-xs text-muted">CPF do pagador: {info.cpf}</p>
          ) : (
            <Field
              label="CPF do titular"
              inputMode="numeric"
              autoComplete="off"
              placeholder="000.000.000-00"
              value={cpf}
              onChange={(e) => setCpf(e.target.value)}
              hint="Pedido só no primeiro depósito. O Pix deve sair de uma conta em seu nome."
            />
          )}
          {error && <FormMessage tone="error">{error}</FormMessage>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="up" busy={busy} disabled={cents === null || !info.depositRate}>
              Gerar Pix
            </Button>
          </div>
        </form>
      )}

      {deposit && deposit.status === 'pending' && (
        <div className="flex flex-col items-center gap-3 text-center" data-testid="deposit-pix">
          <p className="text-sm">
            Pague <strong className="tabular">{formatBrl(deposit.amountCents)}</strong> pelo app do seu banco:
          </p>
          <p className="-mt-2 text-xs text-muted" data-testid="deposit-usd">
            Você recebe <strong className="tabular text-up">{formatMoney(deposit.usdCents)}</strong> ({formatFxRate(deposit.fxRate)})
          </p>
          {qr ? (
            <img src={qr} alt="QR Code do Pix" className="size-56 rounded-control bg-white p-2" />
          ) : (
            <div className="size-56 animate-pulse rounded-control bg-field" />
          )}
          <div className="w-full">
            <div className="mb-1 text-left text-xs text-muted">Pix copia e cola</div>
            <div className="flex gap-2">
              <input
                readOnly
                value={deposit.pixCode ?? ''}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 truncate rounded-control border border-border bg-field px-3 py-2 text-xs"
                aria-label="Código Pix copia e cola"
              />
              <Button variant="secondary" onClick={copy}>
                {copied ? 'Copiado!' : 'Copiar'}
              </Button>
            </div>
          </div>
          <p className="flex items-center gap-2 text-xs text-muted" role="status">
            <span className="size-2 animate-pulse rounded-full bg-warn" /> Aguardando o pagamento… esta janela atualiza sozinha.
          </p>
        </div>
      )}

      {deposit && deposit.status === 'paid' && (
        <>
          <FormMessage tone="success">
            Depósito de {formatBrl(deposit.amountCents)} confirmado! {formatMoney(deposit.usdCents)} já estão na sua conta real.
          </FormMessage>
          <div className="flex justify-end">
            <Button onClick={onClose}>Começar a negociar</Button>
          </div>
        </>
      )}

      {deposit && (deposit.status === 'expired' || deposit.status === 'failed') && (
        <>
          <FormMessage tone="error">
            Este Pix {deposit.status === 'expired' ? 'expirou' : 'não foi concluído'}. Gere um novo para depositar.
          </FormMessage>
          <div className="flex justify-end">
            <Button onClick={() => setDeposit(null)}>Gerar outro</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

const KEY_PLACEHOLDER: Record<PixKeyType, string> = {
  CPF: '000.000.000-00',
  CNPJ: '00.000.000/0000-00',
  EMAIL: 'voce@email.com',
  PHONE: '(11) 99999-9999',
  RANDOM: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
};

const pctText = (p: number) => p.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/**
 * Pix withdrawal request from the real account. Standard: lower fee, an admin reviews it (up to 3 business days).
 * Automatic: higher fee, sent at once.
 */
export function WithdrawDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { accounts, refreshWallet } = useSessionData();
  const { info, error: infoError } = usePaymentsInfo(open);
  const [amount, setAmount] = useState('');
  const [keyType, setKeyType] = useState<PixKeyType>('CPF');
  const [key, setKey] = useState('');
  const [speed, setSpeed] = useState<WithdrawalSpeed>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ usd: number; fee: number; brl: number; speed: WithdrawalSpeed; sent: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setError(null);
    setAmount('');
    setKey('');
    setSpeed('standard');
  }, [open]);

  const hide = useHideBalances();
  const realBalance = accounts.status === 'ready' ? (accounts.data.find((a) => a.account === 'real')?.balanceCents ?? 0) : null;
  const cents = parseMoneyToCents(amount);
  // Same rule as the server: the fee comes out of the amount asked, the Pix carries the rest.
  const instantPct = info?.instantWithdrawFeePct ?? null;
  const chosen: WithdrawalSpeed = speed === 'instant' && instantPct !== null ? 'instant' : 'standard';
  const feePct = info ? (chosen === 'instant' ? (instantPct ?? 0) : info.withdrawFeePct) : 0;
  const fee = cents !== null && info ? withdrawalFeeCents(cents, feePct) : null;
  const net = cents !== null && fee !== null ? cents - fee : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info || cents === null) return;
    if (cents < info.withdrawMinCents) return setError(`O saque mínimo é ${formatMoney(info.withdrawMinCents)}.`);
    if (realBalance !== null && cents > realBalance) return setError('Valor maior que o saldo da conta real.');
    setBusy(true);
    setError(null);
    try {
      const w = await api.createWithdrawal({ amountCents: cents, pixKeyType: keyType, pixKey: key, speed: chosen });
      setDone({
        usd: w.amountCents,
        fee: w.feeCents,
        brl: w.pixAmountCents,
        speed: w.speed,
        sent: w.status !== 'requested' && w.status !== 'approved',
      });
      void refreshWallet();
    } catch (err) {
      setError(errMsg(err, 'Não foi possível pedir o saque.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Sacar via Pix" onClose={onClose}>
      {infoError && <FormMessage tone="error">{infoError}</FormMessage>}
      {!info && !infoError && <LoadingState label="Carregando…" />}
      {info && !info.enabled && <FormMessage tone="info">Saques ainda não estão disponíveis. Tente novamente mais tarde.</FormMessage>}

      {info?.enabled && info.kycStatus !== 'approved' && <KycGate info={info} onClose={onClose} />}
      {info?.enabled && info.kycStatus === 'approved' && done === null && (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <div className="rounded-control border border-border bg-field px-3 py-2">
            <div className="text-xs text-muted">Disponível na conta real</div>
            <div className="tabular text-lg font-bold text-up">{realBalance === null ? '—' : hide.money(realBalance)}</div>
          </div>
          <div className="flex items-end gap-2">
            <Field
              label="Valor (US$)"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1"
              hint={`Mínimo ${formatMoney(info.withdrawMinCents)}.`}
            />
            {realBalance !== null && realBalance > 0 && (
              <Button variant="secondary" className="mb-6" onClick={() => setAmount(centsToText(realBalance))}>
                Tudo
              </Button>
            )}
          </div>
          {instantPct !== null && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Tipo de saque</span>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo de saque">
                {(
                  [
                    ['standard', 'Normal', `Taxa ${pctText(info.withdrawFeePct)}%`, 'Até 3 dias úteis'],
                    ['instant', 'Automático', `Taxa ${pctText(instantPct)}%`, 'Enviado na hora'],
                  ] as const
                ).map(([value, title, feeLine, timeLine]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={chosen === value}
                    data-testid={`speed-${value}`}
                    onClick={() => setSpeed(value)}
                    className={cx(
                      'rounded-control border px-3 py-2 text-left',
                      chosen === value ? 'border-brand bg-brand/10' : 'border-border hover:border-muted',
                    )}
                  >
                    <div className={cx('text-sm font-semibold', chosen === value && 'text-brand')}>{title}</div>
                    <div className="text-xs text-muted">{feeLine}</div>
                    <div className="text-xs text-muted">{timeLine}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {feePct > 0 && (
            <div className="flex flex-col gap-0.5 text-sm" data-testid="withdraw-fee">
              <div className="flex justify-between">
                <span className="text-muted">Taxa de saque ({pctText(feePct)}%)</span>
                <span className="tabular">{fee === null ? '—' : `− ${formatMoney(fee)}`}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Valor enviado</span>
                <span className="tabular font-medium">{net === null ? '—' : formatMoney(net)}</span>
              </div>
            </div>
          )}
          <ConversionBox
            rate={info.withdrawRate}
            label="Você recebe via Pix"
            value={net !== null && info.withdrawRate ? formatBrl(usdToBrlCents(net, info.withdrawRate)) : '—'}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Tipo de chave Pix</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tipo de chave Pix">
              {PIX_KEY_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={keyType === t}
                  onClick={() => setKeyType(t)}
                  className={cx(
                    'rounded-control border px-2.5 py-1 text-xs font-medium',
                    keyType === t ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:text-text',
                  )}
                >
                  {PIX_KEY_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <Field
            label="Chave Pix"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={KEY_PLACEHOLDER[keyType]}
            autoComplete="off"
          />
          <p className="text-xs text-muted">
            {chosen === 'instant'
              ? 'O valor sai do saldo agora e o Pix é enviado na hora, sem análise. Use uma chave em seu nome.'
              : 'O valor sai do saldo agora e o saque passa por análise; você recebe em até 3 dias úteis. Use uma chave em seu nome.'}
          </p>
          {error && <FormMessage tone="error">{error}</FormMessage>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" busy={busy} disabled={cents === null || key.trim() === '' || !info.withdrawRate}>
              Pedir saque
            </Button>
          </div>
        </form>
      )}

      {done !== null && (
        <>
          <FormMessage tone="success">
            Pedido de saque de {formatMoney(done.usd)}
            {done.fee > 0 ? ` (taxa de ${formatMoney(done.fee)})` : ''}: você recebe {formatBrl(done.brl)} via Pix.{' '}
            {done.speed === 'instant' && done.sent
              ? 'O Pix já foi enviado; você acompanha o andamento na Carteira.'
              : done.speed === 'instant'
                ? 'Estamos concluindo o envio; você acompanha o andamento na Carteira.'
                : 'Ele está em análise (até 3 dias úteis) e você acompanha o andamento na Carteira.'}
          </FormMessage>
          <div className="flex justify-end">
            <Button onClick={onClose}>Fechar</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

const STATUS_TONE: Record<string, string> = {
  paid: 'text-up',
  completed: 'text-up',
  pending: 'text-warn',
  requested: 'text-warn',
  approved: 'text-warn',
  processing: 'text-warn',
};

/** Recent Pix deposits and withdrawals with their status, for the wallet page. */
export function PaymentsHistory() {
  const { accounts } = useSessionData();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.payments>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'deposit' | 'withdraw' | null>(null);
  // Reload whenever balances change (a deposit confirmed, a withdrawal requested…).
  useEffect(() => {
    let cancelled = false;
    api.payments().then(
      (r) => !cancelled && setData(r),
      (err: unknown) => !cancelled && setError(errMsg(err, 'Não foi possível carregar.')),
    );
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  const rows = data
    ? [
        ...data.deposits.map((d) => ({
          id: d.id,
          at: d.createdAt,
          kind: 'Depósito Pix',
          cents: d.usdCents,
          brl: d.amountCents,
          status: d.status,
          label: DEPOSIT_STATUS_LABEL[d.status],
          note: null as string | null,
        })),
        ...data.withdrawals.map((w) => ({
          id: w.id,
          at: w.createdAt,
          kind: `Saque Pix${w.speed === 'instant' ? ' automático' : ''} (${PIX_KEY_LABEL[w.pixKeyType]})`,
          cents: -w.amountCents,
          brl: w.pixAmountCents,
          status: w.status,
          label: WITHDRAWAL_STATUS_LABEL[w.status],
          note: w.note,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at))
    : [];

  return (
    <section className="mb-4 rounded-card border border-border bg-surface" aria-labelledby="payments-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="payments-title" className="text-base font-semibold">
          Depósitos e saques
        </h2>
        <div className="flex gap-2">
          <Button variant="up" onClick={() => setDialog('deposit')}>
            Depositar
          </Button>
          <Button variant="secondary" onClick={() => setDialog('withdraw')}>
            Sacar
          </Button>
        </div>
      </div>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      {!data && !error && <LoadingState label="Carregando…" />}
      {data && rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">Nenhum depósito ou saque ainda.</p>}
      {rows.length > 0 && (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm" data-testid="payment-row">
              <div className="min-w-0">
                <div className="font-medium">{r.kind}</div>
                <div className="text-xs text-muted">
                  {formatDateTime(r.at)} · {formatBrl(r.brl)}
                  {r.note ? ` — ${r.note}` : ''}
                </div>
              </div>
              <div className="text-right">
                <div className={cx('tabular font-semibold', r.cents > 0 ? 'text-up' : 'text-text')}>{formatSignedMoney(r.cents)}</div>
                <div className={cx('text-xs', STATUS_TONE[r.status] ?? 'text-muted')}>{r.label}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <DepositDialog open={dialog === 'deposit'} onClose={() => setDialog(null)} />
      <WithdrawDialog open={dialog === 'withdraw'} onClose={() => setDialog(null)} />
    </section>
  );
}
