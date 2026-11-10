import { useEffect, useId, useRef, useState } from 'react';
import { candleExpiry, type AccountKind, type AssetView, type Direction, type OrderLimitsView, type OrderView } from '@traderoom/shared';
import { api, ApiError, newIdempotencyKey } from '../lib/api';
import { serverClock } from '../lib/clock';
import type { FeedStatus, Quote } from '../lib/feed';
import { formatDuration, formatMoney, formatPrice, parseMoneyToCents, TIME_ZONE } from '../lib/format';
import { expectedProfitCents } from '../lib/orders';
import { playOrderSound, unlockSound } from '../lib/sound';
import { cx, FormMessage, Spinner } from './ui';

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
  /** Picked expiry (seconds); kept by the page so the chart can draw it. */
  durationSec: number;
  onDurationChange(sec: number): void;
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
  // No fresh price: wait quietly, no alarm for the client.
  if (!p.quote || p.quote.price === null || p.quote.stale) return 'Aguardando cotação…';
  if (p.stakeCents === null) return 'Informe um valor válido.';
  if (p.stakeCents < p.limits.minStakeCents) return `Valor mínimo: ${formatMoney(p.limits.minStakeCents)}.`;
  if (p.stakeCents > p.limits.maxStakeCents) return `Valor máximo: ${formatMoney(p.limits.maxStakeCents)}.`;
  if (p.balanceCents === null) return 'Carregando saldo…';
  if (p.balanceCents < p.stakeCents) return 'Saldo insuficiente para este valor.';
  return null;
}

const HHMM = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE });

/** "20:00": Brasília time when an order sent now would expire (candle-aligned, as the API does). */
export function expiryClock(nowMs: number, durationSec: number): string {
  return HHMM.format(new Date(candleExpiry(nowMs, durationSec).closesAt));
}

/** "1 minuto", "5 minutos", "1 hora": how the expiry options read in the panel. */
export function durationLabel(sec: number): string {
  if (sec % 3600 === 0) return sec === 3600 ? '1 hora' : `${sec / 3600} horas`;
  if (sec % 60 === 0) return sec === 60 ? '1 minuto' : `${sec / 60} minutos`;
  return `${sec} segundos`;
}

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => serverClock.serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverClock.serverNow()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

function HelpDot() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[10px] text-[#91959c]" fill="currentColor">
      <path d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22zm.1 15.2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 5C9.7 5 8 6.4 7.9 8.6h2.6c.1-.9.7-1.4 1.6-1.4.9 0 1.5.5 1.5 1.3 0 .7-.3 1-1.3 1.6-1 .7-1.5 1.4-1.4 2.8v.6h2.5v-.5c0-.8.3-1.2 1.3-1.8 1-.7 1.8-1.5 1.8-2.8C16.5 6.4 14.7 5 12 5z" />
    </svg>
  );
}

/** "+" / "−" pair to the right of a field. */
function Steppers({
  label,
  onUp,
  onDown,
  upDisabled,
  downDisabled,
}: {
  label: string;
  onUp(): void;
  onDown(): void;
  upDisabled?: boolean;
  downDisabled?: boolean;
}) {
  const cls =
    'flex flex-1 items-center justify-center rounded-[2px] bg-[#232c39] text-[15px] leading-none font-bold text-[#91959c] hover:text-text disabled:opacity-40 disabled:hover:text-[#91959c]';
  return (
    <div className="flex w-[18px] shrink-0 flex-col gap-[2px]">
      <button type="button" aria-label={`Aumentar ${label}`} onClick={onUp} disabled={upDisabled} className={cls}>
        +
      </button>
      <button type="button" aria-label={`Diminuir ${label}`} onClick={onDown} disabled={downDisabled} className={cls}>
        −
      </button>
    </div>
  );
}

/** Kyden-style order column: Invest, Expiração, Lucro, then the big ACIMA / ABAIXO buttons. */
export function OrderPanel({ account, asset, limits, quote, feedStatus, balanceCents, onPlaced, durationSec, onDurationChange }: Props) {
  const ids = useId();
  const [stakeText, setStakeText] = useState(() => String(limits.minStakeCents / 100).replace('.', ','));
  const setDurationSec = onDurationChange;
  const [sending, setSending] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const expiryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expiryOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!expiryRef.current?.contains(e.target as Node)) setExpiryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpiryOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [expiryOpen]);

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
      const order = await api.createOrder({ account, assetId: asset.id, direction, stakeCents, durationSec }, newIdempotencyKey());
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

  const tradeBtn =
    'flex min-h-[64px] flex-1 flex-col items-center justify-center gap-1.5 rounded-[3px] text-[13px] font-bold text-white uppercase transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 lg:max-h-[108px]';

  return (
    <section className="flex h-full flex-col gap-2 lg:gap-[9px]" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="sr-only">
        Nova ordem em {asset.display}
      </h2>
      <span className="sr-only" data-testid="panel-price">
        {quote?.price != null ? formatPrice(quote.price) : '—'}
      </span>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-1 lg:gap-[9px]">
        <div className="flex h-[48px] gap-[2px]">
          <label
            htmlFor={`${ids}-stake`}
            className="flex min-w-0 flex-1 flex-col justify-center rounded-[3px] border border-[#334054] px-2.5 focus-within:border-[#4b5a72]"
          >
            <span className="flex items-center justify-between text-[12px] leading-none text-[#91959c]">
              Invest <HelpDot />
            </span>
            <span className="mt-1 flex items-baseline gap-1.5 text-[15px] leading-none">
              <span className="text-[#91959c]">$</span>
              <input
                id={`${ids}-stake`}
                inputMode="decimal"
                autoComplete="off"
                value={stakeText}
                onChange={(e) => setStakeText(e.target.value)}
                aria-invalid={stakeCents === null || undefined}
                className="tabular w-full min-w-0 bg-transparent text-text outline-none"
              />
            </span>
          </label>
          <Steppers label="valor" onUp={() => nudgeStake(1)} onDown={() => nudgeStake(-1)} />
        </div>

        <div ref={expiryRef} className="relative flex h-[48px] gap-[2px]">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={expiryOpen}
            onClick={() => setExpiryOpen((v) => !v)}
            className="flex min-w-0 flex-1 flex-col justify-center rounded-[3px] bg-[#232c39] px-2.5 text-left hover:bg-[#2a3444]"
            title={`Termina às ${expiryClock(now, durationSec)}`}
          >
            <span id={`${ids}-time`} className="flex w-full items-center justify-between text-[12px] leading-none text-[#91959c]">
              Expiração <HelpDot />
            </span>
            <span className="mt-1 flex items-center text-[13px] leading-none whitespace-nowrap text-text">
              <output aria-labelledby={`${ids}-time`} aria-live="polite" className="tabular" data-duration={formatDuration(durationSec)}>
                {durationLabel(durationSec)}
              </output>
            </span>
          </button>
          {expiryOpen && (
            <ul
              role="listbox"
              aria-labelledby={`${ids}-time`}
              className="absolute top-0 right-full z-40 mr-2 w-[150px] overflow-hidden rounded-[3px] border border-border bg-[#1b222c] py-1 shadow-2xl"
            >
              {limits.durationsSec.map((sec) => (
                <li key={sec} role="option" aria-selected={sec === durationSec}>
                  <button
                    type="button"
                    onClick={() => {
                      setDurationSec(sec);
                      setExpiryOpen(false);
                    }}
                    className={cx(
                      'flex w-full items-center justify-between px-3 py-2 text-[13px] hover:bg-[#232c39]',
                      sec === durationSec ? 'text-up' : 'text-text',
                    )}
                  >
                    {durationLabel(sec)}
                    <span className="tabular text-[11px] text-muted">{expiryClock(now, sec)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Steppers
            label="tempo"
            onUp={() => setDurationSec(stepDuration(limits.durationsSec, durationSec, 1))}
            onDown={() => setDurationSec(stepDuration(limits.durationsSec, durationSec, -1))}
            upDisabled={durationIdx >= limits.durationsSec.length - 1}
            downDisabled={durationIdx <= 0}
          />
        </div>
      </div>

      <div className="flex items-baseline justify-center gap-3 py-1 text-up lg:flex-col lg:items-center lg:gap-0 lg:pt-3 lg:pb-1">
        <span className="flex items-center gap-1 text-[12px] text-text">
          Lucro <HelpDot />
        </span>
        <span className="tabular text-[26px] leading-none font-light lg:mt-2.5 lg:text-[38px]">
          +{asset.payoutPct}
          <span className="text-[20px] lg:text-[26px]">%</span>
        </span>
        <span className="tabular text-[15px] font-bold lg:mt-2.5 lg:text-[17px]" aria-label="Lucro se acertar">
          {stakeCents ? `+${formatMoney(profit)}` : '—'}
        </span>
      </div>

      <div className="grid min-h-0 grid-cols-2 gap-2 lg:flex lg:flex-1 lg:flex-col lg:gap-[8px]">
        <button
          type="button"
          className={cx(tradeBtn, 'bg-up')}
          disabled={reason !== null || sending !== null}
          aria-busy={sending === 'call' || undefined}
          onClick={() => void place('call')}
          aria-describedby={reason ? `${ids}-reason` : undefined}
        >
          {sending === 'call' ? <Spinner small /> : <TrendIcon up />}
          <span>Acima</span>
        </button>
        <button
          type="button"
          className={cx(tradeBtn, 'bg-down')}
          disabled={reason !== null || sending !== null}
          aria-busy={sending === 'put' || undefined}
          onClick={() => void place('put')}
          aria-describedby={reason ? `${ids}-reason` : undefined}
        >
          {sending === 'put' ? <Spinner small /> : <TrendIcon up={false} />}
          <span>Abaixo</span>
        </button>
      </div>

      {reason && (
        <p id={`${ids}-reason`} className="text-center text-[11px] leading-snug text-warn" data-testid="block-reason">
          {reason}
        </p>
      )}
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </section>
  );
}

/** Bars with a trend line: rising for ACIMA, falling for ABAIXO. */
function TrendIcon({ up }: { up: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 24" className="h-[22px] w-[30px]" fill="currentColor">
      {up ? (
        <>
          <rect x="2" y="17" width="4" height="6" />
          <rect x="9" y="13" width="4" height="10" />
          <rect x="16" y="15" width="4" height="8" />
          <rect x="23" y="9" width="4" height="14" />
          <path d="M2 13l8-7 6 4 9-8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
          <path d="M21 1h7v7z" />
        </>
      ) : (
        <>
          <rect x="2" y="9" width="4" height="14" />
          <rect x="9" y="15" width="4" height="8" />
          <rect x="16" y="13" width="4" height="10" />
          <rect x="23" y="19" width="4" height="4" />
          <path d="M2 2l8 7 6-4 9 8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
          <path d="M21 16h7V9z" />
        </>
      )}
    </svg>
  );
}
