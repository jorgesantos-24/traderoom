import { useEffect, useId, useState } from 'react';
import type { AccountKind, AssetView, Direction, OrderLimitsView, OrderView } from '@traderoom/shared';
import { api, ApiError, newIdempotencyKey } from '../lib/api';
import type { FeedStatus, Quote } from '../lib/feed';
import { formatDuration, formatMoney, formatPrice, parseMoneyToCents } from '../lib/format';
import { expectedProfitCents } from '../lib/orders';
import { playOrderSound, unlockSound } from '../lib/sound';
import { Button, Card, cx, FormMessage } from './ui';

/** Next/previous allowed expiry; stays put at either end of the list. */
export function stepDuration(options: readonly number[], current: number, sign: 1 | -1): number {
  const i = options.indexOf(current);
  if (i === -1) return options[0] ?? current;
  return options[Math.min(options.length - 1, Math.max(0, i + sign))] as number;
}

export const STAKE_PRESETS_CENTS = [1000, 2500, 5000, 10000] as const;

/** "+" doubles the stake, "−" halves it (down to the cent), clamped to the limits. */
export function nextStakeCents(cents: number, sign: 1 | -1, limits: Pick<OrderLimitsView, 'minStakeCents' | 'maxStakeCents'>): number {
  const raw = sign === 1 ? cents * 2 : Math.floor(cents / 2);
  return Math.min(limits.maxStakeCents, Math.max(limits.minStakeCents, raw));
}

interface Props {
  /** Which balance pays the stake. */
  account: AccountKind;
  asset: AssetView;
  limits: OrderLimitsView;
  quote: Quote | null;
  feedStatus: FeedStatus;
  balanceCents: number | null;
  onPlaced(order: OrderView): void;
}

/** Why the call/put buttons are disabled, or null when an order can be sent. */
export function blockReason(p: {
  feedStatus: FeedStatus;
  quote: Quote | null;
  balanceCents: number | null;
  stakeCents: number | null;
  limits: OrderLimitsView;
}): string | null {
  if (p.feedStatus !== 'open') return 'Sem conexão com as cotações. Reconectando…';
  if (!p.quote || (p.quote.price === null && !p.quote.stale)) return 'Aguardando cotação…';
  if (p.quote.stale) return 'Cotação defasada: novas ordens estão bloqueadas neste ativo.';
  if (p.stakeCents === null) return 'Informe um valor válido.';
  if (p.stakeCents < p.limits.minStakeCents) return `Valor mínimo: ${formatMoney(p.limits.minStakeCents)}.`;
  if (p.stakeCents > p.limits.maxStakeCents) return `Valor máximo: ${formatMoney(p.limits.maxStakeCents)}.`;
  if (p.balanceCents === null) return 'Carregando saldo…';
  if (p.balanceCents < p.stakeCents) return 'Saldo insuficiente para este valor.';
  return null;
}

export function OrderPanel({ account, asset, limits, quote, feedStatus, balanceCents, onPlaced }: Props) {
  const ids = useId();
  const presets = STAKE_PRESETS_CENTS.filter((c) => c >= limits.minStakeCents && c <= limits.maxStakeCents);
  const [stakeText, setStakeText] = useState(() => String((presets[0] ?? limits.minStakeCents) / 100));
  const [durationSec, setDurationSec] = useState(limits.durationsSec[0] ?? 60);
  const [sending, setSending] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!limits.durationsSec.includes(durationSec)) setDurationSec(limits.durationsSec[0] ?? 60);
  }, [limits, durationSec]);
  useEffect(() => setError(null), [asset.id]);

  const durationIdx = limits.durationsSec.indexOf(durationSec);
  const stakeCents = parseMoneyToCents(stakeText);
  const reason = blockReason({ feedStatus, quote, balanceCents, stakeCents, limits });
  const profit = stakeCents ? expectedProfitCents(stakeCents, asset.payoutPct) : 0;

  const place = async (direction: Direction) => {
    if (reason || stakeCents === null || sending) return;
    unlockSound();
    setSending(direction);
    setError(null);
    try {
      const order = await api.createOrder(
        { account, assetId: asset.id, direction, stakeCents, durationSec },
        newIdempotencyKey(),
      );
      playOrderSound(direction);
      onPlaced(order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar a ordem.');
    } finally {
      setSending(null);
    }
  };

  const nudgeStake = (sign: 1 | -1) => {
    const base = stakeCents ?? limits.minStakeCents;
    const next = nextStakeCents(base, sign, limits);
    setStakeText((next / 100).toFixed(next % 100 === 0 ? 0 : 2).replace('.', ','));
  };

  return (
    <Card className="flex flex-col gap-3 p-3" aria-labelledby={`${ids}-title`}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${ids}-title`} className="text-sm font-semibold">
          Nova ordem
        </h2>
        <span
          className={cx('tabular text-sm font-semibold', quote?.stale ? 'text-muted' : 'text-text')}
          data-testid="panel-price"
        >
          {quote?.price != null ? formatPrice(quote.price) : '—'}
        </span>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Valor</legend>
        <div className="flex items-stretch rounded-control border border-border bg-field focus-within:border-brand">
          <label htmlFor={`${ids}-stake`} className="flex flex-1 flex-col px-3 py-1.5">
            <span className="text-[11px] text-muted">Valor (R$)</span>
            <input
              id={`${ids}-stake`}
              inputMode="decimal"
              autoComplete="off"
              value={stakeText}
              onChange={(e) => setStakeText(e.target.value)}
              aria-invalid={stakeCents === null || undefined}
              className="tabular w-full bg-transparent text-lg font-semibold text-text outline-none"
            />
          </label>
          <div className="flex flex-col border-l border-border">
            <button
              type="button"
              aria-label="Aumentar valor"
              onClick={() => nudgeStake(1)}
              className="flex-1 px-3 text-muted hover:bg-field hover:text-text"
            >
              +
            </button>
            <button
              type="button"
              aria-label="Diminuir valor"
              onClick={() => nudgeStake(-1)}
              className="flex-1 border-t border-border px-3 text-muted hover:bg-field hover:text-text"
            >
              −
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {presets.map((c) => {
            const active = stakeCents === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => setStakeText(String(c / 100))}
                className={cx(
                  'tabular whitespace-nowrap rounded-control px-1 py-1 text-xs font-semibold',
                  active ? 'bg-brand/15 text-brand' : 'bg-field text-muted hover:text-text',
                )}
              >
                R$ {c / 100}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex items-stretch rounded-control border border-border bg-field">
        <div className="flex flex-1 flex-col px-3 py-1.5">
          <span id={`${ids}-time`} className="text-[11px] text-muted">
            Tempo
          </span>
          <output aria-labelledby={`${ids}-time`} aria-live="polite" className="tabular text-lg font-semibold text-text">
            {formatDuration(durationSec)}
          </output>
        </div>
        <div className="flex flex-col border-l border-border">
          <button
            type="button"
            aria-label="Aumentar tempo"
            onClick={() => setDurationSec(stepDuration(limits.durationsSec, durationSec, 1))}
            disabled={durationIdx >= limits.durationsSec.length - 1}
            className="flex-1 px-3 text-muted hover:bg-field hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Diminuir tempo"
            onClick={() => setDurationSec(stepDuration(limits.durationsSec, durationSec, -1))}
            disabled={durationIdx <= 0}
            className="flex-1 border-t border-border px-3 text-muted hover:bg-field hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
          >
            −
          </button>
        </div>
      </div>

      <div className="flex flex-col items-center py-1">
        <span className="text-xs text-muted">Retorno</span>
        <span className="tabular text-4xl leading-none font-bold text-up">{asset.payoutPct}%</span>
        <span className="tabular mt-1 text-sm font-semibold text-up" aria-label="Lucro se acertar">
          {stakeCents ? `+${formatMoney(profit)}` : '—'}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          variant="up"
          className="gap-1.5 py-3.5 text-base shadow-[0_8px_24px_-12px] shadow-up/60"
          disabled={reason !== null || sending !== null}
          busy={sending === 'call'}
          onClick={() => void place('call')}
          aria-describedby={reason ? `${ids}-reason` : undefined}
        >
          <span>Comprar</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5">
            <path d="M6 18L18 6M9 6h9v9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
        <Button
          variant="down"
          className="gap-1.5 py-3.5 text-base shadow-[0_8px_24px_-12px] shadow-down/60"
          disabled={reason !== null || sending !== null}
          busy={sending === 'put'}
          onClick={() => void place('put')}
          aria-describedby={reason ? `${ids}-reason` : undefined}
        >
          <span>Vender</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5">
            <path d="M6 6l12 12M18 9v9H9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
      </div>

      {reason && (
        <p id={`${ids}-reason`} className="text-xs text-warn" data-testid="block-reason">
          {reason}
        </p>
      )}
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </Card>
  );
}
