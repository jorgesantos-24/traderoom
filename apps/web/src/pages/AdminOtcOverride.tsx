import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_MS,
  candleBucket,
  OTC_OVERRIDE_MIN_LEAD_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS,
  type CandleInterval,
  type OtcOverrideAsset,
  type OtcOverrideView,
} from '@traderoom/shared';
import { AppShell } from '../components/AppShell';
import { Button, Card, cx, EmptyState, ErrorState, Field, FormMessage, LoadingState } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useUser } from '../lib/auth';
import { serverClock } from '../lib/clock';
import { formatCountdown, formatPrice } from '../lib/format';
import {
  editedCandle,
  gridStep,
  phaseAt,
  PHASE_LABEL,
  priceScale,
  priceToY,
  rampPlan,
  requiredSpeed,
  roundTo,
  withLiveCandle,
  yToPrice,
  type Ohlc,
  type PriceScale,
} from '../lib/otc-override';
import { Link } from '../lib/router';
import { useQuote } from '../lib/session-data';

const CANDLES = 60;
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Server-clock "now", re-rendering every `ms`. */
function useServerNow(ms: number): number {
  const [now, setNow] = useState(() => serverClock.serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverClock.serverNow()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; assets: OtcOverrideAsset[] };

export function AdminOtcOverridePage() {
  const user = useUser();
  if (user.role !== 'admin') {
    return (
      <AppShell>
        <EmptyState title="Acesso restrito" hint="Esta área é só para administradores." className="h-96" />
      </AppShell>
    );
  }
  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Intervenção no preço OTC</h1>
        <Link href="/admin" className="text-sm text-muted hover:text-text">
          ← Voltar ao admin
        </Link>
      </div>
      <OverrideScreen />
    </AppShell>
  );
}

function OverrideScreen() {
  const ids = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [override, setOverride] = useState<OtcOverrideView | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<number | null>(null);
  const [interval, setInterval_] = useState<CandleInterval>('1m');
  const [candles, setCandles] = useState<Ohlc[]>([]);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [targetText, setTargetText] = useState('');
  const [nextCandle, setNextCandle] = useState(false);
  const [busy, setBusy] = useState<'apply' | 'release' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const now = useServerNow(250);

  // Override state: every second while one is active (phase changes fast), every 4 s otherwise.
  const refresh = useCallback(async () => {
    const r = await api.admin.otcOverride();
    setOverride(r.override);
    setPollError(null);
    return r;
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh().then(
      (r) => {
        if (cancelled) return;
        setLoad({ status: 'ready', assets: r.assets });
        setAssetId((cur) => cur ?? r.override?.assetId ?? r.assets[0]?.id ?? null);
      },
      (err: unknown) => !cancelled && setLoad({ status: 'error', message: errMsg(err, 'Erro ao carregar.') }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, refresh]);

  const active = override !== null;
  useEffect(() => {
    if (load.status !== 'ready') return;
    const t = setInterval(
      () => void refresh().catch((err: unknown) => setPollError(errMsg(err, 'Sem conexão com o servidor.'))),
      active ? 1000 : 4000,
    );
    return () => clearInterval(t);
  }, [load.status, active, refresh]);

  const assets = load.status === 'ready' ? load.assets : [];
  const asset = assets.find((a) => a.id === assetId) ?? null;
  const symbol = asset?.symbol ?? null;
  const decimals = asset?.decimals ?? 2;
  const market = asset?.kind === 'market';
  // Market assets: only the 1m close can be set.
  useEffect(() => {
    if (market) setInterval_('1m');
  }, [market]);
  const quote = useQuote(symbol);
  const price = quote?.price ?? null;

  const stepMs = CANDLE_INTERVAL_MS[interval];
  const bucket = candleBucket(now, stepMs);

  // History: on asset/interval change, every 10 s, and when a new candle opens.
  useEffect(() => {
    if (!symbol) return;
    const ctrl = new AbortController();
    const fetchCandles = () =>
      api.candles(symbol, interval, CANDLES, ctrl.signal).then(
        (r) => {
          setCandles(r.candles);
          setCandlesError(null);
        },
        (err: unknown) => {
          if (!ctrl.signal.aborted) setCandlesError(errMsg(err, 'Erro ao carregar as velas.'));
        },
      );
    void fetchCandles();
    const t = setInterval(() => void fetchCandles(), 10_000);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [symbol, interval, bucket.openMs]);

  // A new asset or interval starts a fresh edit.
  useEffect(() => {
    setTarget(null);
    setTargetText('');
    setActionError(null);
  }, [symbol, interval]);

  const leadMs = bucket.closeMs - now;
  const tooLate = leadMs < OTC_OVERRIDE_MIN_LEAD_MS;
  // The checkbox only exists while it is too late; when a new candle opens it goes away and resets.
  useEffect(() => {
    if (!tooLate) setNextCandle(false);
  }, [tooLate]);
  const useNext = tooLate && nextCandle;
  const closeMs = useNext ? bucket.closeMs + stepMs : bucket.closeMs;
  // Market: the server ramps over the rest of the candle.
  const plan = rampPlan(now, closeMs, market ? 60_000 : undefined);

  const activeHere = override !== null && override.assetId === assetId;
  const canEdit = !active && price !== null;
  const live = useMemo(() => withLiveCandle(candles, price, bucket.openMs, CANDLES), [candles, price, bucket.openMs]);
  const distancePct = target !== null && price ? ((target - price) / price) * 100 : null;
  const maxPct = market ? (asset?.maxOverridePct ?? null) : null;
  const overLimit = maxPct !== null && distancePct !== null && Math.abs(distancePct) > maxPct;
  const speed = target !== null && price ? requiredSpeed(price, target, plan.rampMs) : null;

  const setTargetPrice = (p: number) => {
    const r = roundTo(p, decimals);
    if (!(r > 0)) return;
    setTarget(r);
    setTargetText(r.toFixed(decimals));
    setActionError(null);
  };

  const onTargetText = (v: string) => {
    setTargetText(v);
    const n = Number(v.trim().replace(',', '.'));
    setTarget(v.trim() !== '' && Number.isFinite(n) && n > 0 ? roundTo(n, decimals) : null);
  };

  const apply = async () => {
    if (!asset || target === null) return;
    setBusy('apply');
    setActionError(null);
    try {
      const v = await api.admin.applyOtcOverride({
        assetId: asset.id,
        interval,
        targetPrice: target,
        rampMs: OTC_OVERRIDE_RAMP_DEFAULT_MS,
        nextCandle: useNext,
      });
      setOverride(v);
      setNotice(`Override aplicado: ${v.symbol} fecha em ${formatPrice(v.targetPrice, v.decimals)}.`);
    } catch (err) {
      setActionError(errMsg(err, 'Não foi possível aplicar.'));
    } finally {
      setBusy(null);
    }
  };

  const release = async () => {
    setBusy('release');
    setActionError(null);
    try {
      await api.admin.releaseOtcOverride();
      setOverride(null);
      setTarget(null);
      setTargetText('');
      setNotice('Override solto; o preço segue o caminho natural.');
      void refresh().catch(() => {});
    } catch (err) {
      setActionError(errMsg(err, 'Não foi possível soltar.'));
    } finally {
      setBusy(null);
    }
  };

  if (load.status === 'loading') return <LoadingState label="Carregando…" />;
  if (load.status === 'error') {
    return (
      <Card>
        <ErrorState
          message={load.message}
          onRetry={() => {
            setLoad({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      </Card>
    );
  }
  if (assets.length === 0) {
    return (
      <Card>
        <EmptyState title="Nenhum ativo OTC habilitado" hint="Habilite um ativo OTC na aba Ativos do admin." />
      </Card>
    );
  }

  const fmt = (p: number | null) => (p === null ? '—' : formatPrice(p, decimals));
  const applyBlocked = active || target === null || price === null || (tooLate && !nextCandle) || target === price;

  return (
    <div className="flex flex-col gap-4">
      <div role="status" aria-live="polite" className="sr-only">
        {notice}
      </div>

      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-asset`} className="text-sm font-medium">
            Ativo
          </label>
          <select
            id={`${ids}-asset`}
            value={assetId ?? ''}
            onChange={(e) => setAssetId(Number(e.target.value))}
            className="rounded-control border border-border bg-field px-3 py-2 text-sm text-text focus:border-brand"
          >
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display} ({a.symbol}){a.kind === 'market' ? ' · mercado' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-interval`} className="text-sm font-medium">
            Intervalo
          </label>
          <select
            id={`${ids}-interval`}
            value={interval}
            onChange={(e) => setInterval_(e.target.value as CandleInterval)}
            disabled={market}
            title={market ? 'Ativos de mercado: só o candle de 1m.' : undefined}
            className="rounded-control border border-border bg-field px-3 py-2 text-sm text-text focus:border-brand disabled:opacity-60"
          >
            {(market ? (['1m'] as const) : CANDLE_INTERVALS).map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
        <dl className="grid w-full sm:ml-auto sm:w-auto grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <dt className="text-muted">Preço atual</dt>
          <dd className="font-mono tabular-nums sm:col-span-2" data-testid="otc-price">
            {fmt(price)}
            {quote?.stale && <span className="ml-2 text-warn">sem cotação recente</span>}
          </dd>
          <dt className="text-muted">Fecha em</dt>
          <dd className={cx('font-mono tabular-nums sm:col-span-2', tooLate && 'text-warn')} data-testid="otc-countdown">
            {formatCountdown(leadMs)}
          </dd>
        </dl>
      </Card>

      <Card className="p-2">
        <OverrideChart
          candles={live}
          decimals={decimals}
          price={price}
          editTarget={!active ? target : null}
          activeTarget={activeHere ? override.targetPrice : null}
          canEdit={canEdit}
          onTarget={setTargetPrice}
        />
        {candlesError && <p className="px-2 pt-2 text-sm text-down">{candlesError}</p>}
        <p className="px-2 pt-2 text-xs text-muted">
          {active
            ? 'Com override ativo o gráfico mostra o preço real; a linha amarela é o alvo.'
            : 'Arraste o corpo ou o pavio da última vela (ou use as setas com o gráfico em foco) para escolher onde ela fecha.'}
        </p>
      </Card>

      {override ? (
        <ActivePanel override={override} now={now} onRelease={release} busy={busy === 'release'} />
      ) : (
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Preço alvo"
              inputMode="decimal"
              value={targetText}
              onChange={(e) => onTargetText(e.target.value)}
              placeholder={price === null ? '' : fmt(price)}
              className="w-full sm:w-48"
            />
            <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Distância</dt>
              <dd className={cx('font-mono tabular-nums', distancePct !== null && (distancePct >= 0 ? 'text-up' : 'text-down'))} data-testid="otc-distance">
                {distancePct === null ? '—' : `${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(3).replace('.', ',')}%`}
              </dd>
              {maxPct !== null && (
                <>
                  <dt className="text-muted">Limite do ativo</dt>
                  <dd className={cx('font-mono tabular-nums', overLimit && 'text-down')} data-testid="otc-max-pct">
                    ±{maxPct.toFixed(3).replace('.', ',')}%{overLimit ? ' (acima do limite)' : ''}
                  </dd>
                </>
              )}
              <dt className="text-muted">Velocidade necessária</dt>
              <dd className="font-mono tabular-nums" data-testid="otc-speed">
                {speed === null
                  ? '—'
                  : `${speed.pricePerSec >= 0 ? '+' : ''}${formatPrice(speed.pricePerSec, decimals)}/s (${speed.pctPerSec.toFixed(4).replace('.', ',')}%/s) em ${(plan.rampMs / 1000).toFixed(1).replace('.', ',')} s de rampa`}
              </dd>
            </dl>
          </div>
          {tooLate && (
            <div className="flex flex-col gap-2">
              <FormMessage tone="info">
                Faltam menos de {OTC_OVERRIDE_MIN_LEAD_MS / 1000} s para o fechamento desta vela: não dá tempo de levar o preço ao alvo.
              </FormMessage>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={nextCandle} onChange={(e) => setNextCandle(e.target.checked)} className="size-4 accent-brand" />
                Aplicar no próximo candle
              </label>
            </div>
          )}
          {actionError && <FormMessage tone="error">{actionError}</FormMessage>}
          <div className="flex gap-2">
            <Button onClick={() => void apply()} busy={busy === 'apply'} disabled={applyBlocked}>
              Aplicar
            </Button>
            {target !== null && (
              <Button variant="ghost" onClick={() => onTargetText('')}>
                Limpar alvo
              </Button>
            )}
          </div>
        </Card>
      )}
      {active && actionError && <FormMessage tone="error">{actionError}</FormMessage>}
      {pollError && <FormMessage tone="error">{pollError}</FormMessage>}
    </div>
  );
}

function ActivePanel({ override: o, now, onRelease, busy }: { override: OtcOverrideView; now: number; onRelease(): void; busy: boolean }) {
  const phase = phaseAt(now, o);
  const remaining = o.candleCloseMs - now;
  const fmt = (p: number | null) => (p === null ? '—' : formatPrice(p, o.decimals));
  return (
    <Card className="flex flex-wrap items-center gap-6 p-4" data-testid="otc-active">
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Ativo</dt>
        <dd>
          {o.display} ({o.symbol}), {o.intervalSec / 60 >= 60 ? `${o.intervalSec / 3600}h` : `${o.intervalSec / 60}m`}
        </dd>
        <dt className="text-muted">Fase</dt>
        <dd className={cx('font-medium', phase === 'hold' ? 'text-warn' : 'text-text')} data-testid="otc-phase">
          {PHASE_LABEL[phase]}
        </dd>
        <dt className="text-muted">{remaining >= 0 ? 'Fecha em' : 'Fechou há'}</dt>
        <dd className="font-mono tabular-nums">
          {formatCountdown(Math.abs(remaining))}
          {phase === 'waiting' && <span className="ml-2 text-muted">rampa em {formatCountdown(o.rampStartMs - now)}</span>}
        </dd>
        <dt className="text-muted">Alvo</dt>
        <dd className="font-mono tabular-nums">{fmt(o.targetPrice)}</dd>
        <dt className="text-muted">Preço base / atual</dt>
        <dd className="font-mono tabular-nums">
          {fmt(o.basePrice)} / {fmt(o.currentPrice)}
        </dd>
      </dl>
      <Button variant="secondary" className="ml-auto" onClick={onRelease} busy={busy}>
        Soltar override
      </Button>
    </Card>
  );
}

// ---- Chart ----

const AXIS_W = 76;
const PAD_T = 12;
const PAD_B = 22;
const HEIGHT = 380;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

interface ChartProps {
  candles: Ohlc[];
  decimals: number;
  price: number | null;
  /** Target being edited: the last candle is drawn as it would close. */
  editTarget: number | null;
  /** Target of the override already running on this asset. */
  activeTarget: number | null;
  canEdit: boolean;
  onTarget(p: number): void;
}

function OverrideChart({ candles, decimals, price, editTarget, activeTarget, canEdit, onTarget }: ChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  /** Scale frozen while dragging, so the axis does not move under the pointer. */
  const frozen = useRef<PriceScale | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = useMemo(() => {
    const last = candles.at(-1);
    if (!last || editTarget === null) return candles;
    return [...candles.slice(0, -1), editedCandle(last, editTarget)];
  }, [candles, editTarget]);

  const scale = frozen.current ?? priceScale(shown, [price, editTarget, activeTarget]);
  const plotW = width - AXIS_W;
  const plotH = HEIGHT - PAD_T - PAD_B;
  const slot = plotW / CANDLES;
  const xOf = (i: number) => (CANDLES - shown.length + i + 0.5) * slot;
  const y = (p: number) => (scale ? priceToY(scale, PAD_T, plotH, p) : 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = {
      bg: cssVar('--color-surface', '#000'),
      grid: cssVar('--color-border', '#2a2c32'),
      text: cssVar('--color-muted', '#89898d'),
      up: cssVar('--color-up', '#4fa65b'),
      down: cssVar('--color-down', '#ef6049'),
      brand: cssVar('--color-brand', '#00d8e8'),
      warn: cssVar('--color-warn', '#f5a524'),
    };
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, HEIGHT);
    if (!scale) {
      ctx.fillStyle = c.text;
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Aguardando cotação…', 16, HEIGHT / 2);
      return;
    }

    // Grid and price axis.
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const step = gridStep(scale);
    for (let p = Math.ceil(scale.min / step) * step; p <= scale.max; p += step) {
      const gy = Math.round(y(p)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(plotW, gy);
      ctx.stroke();
      ctx.fillStyle = c.text;
      ctx.fillText(formatPrice(p, decimals), plotW + 6, gy);
    }
    ctx.strokeStyle = c.grid;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, PAD_T);
    ctx.lineTo(plotW + 0.5, HEIGHT - PAD_B);
    ctx.stroke();

    // Time labels every 10 candles.
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = c.text;
    shown.forEach((k, i) => {
      if (i % 10 !== 0) return;
      const label = new Date(k.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, Math.max(0, xOf(i) - 14), HEIGHT - 6);
    });

    // Candles.
    const bodyW = Math.max(1, Math.floor(slot * 0.62));
    shown.forEach((k, i) => {
      const x = Math.round(xOf(i)) + 0.5;
      const isEdit = editTarget !== null && i === shown.length - 1;
      const color = k.c >= k.o ? c.up : c.down;
      ctx.globalAlpha = isEdit ? 0.55 : 1;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y(k.h));
      ctx.lineTo(x, y(k.l));
      ctx.stroke();
      const top = y(Math.max(k.o, k.c));
      const h = Math.max(1, y(Math.min(k.o, k.c)) - top);
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      ctx.globalAlpha = 1;
      if (isEdit) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = c.brand;
        ctx.strokeRect(x - bodyW / 2 - 2, top - 2, bodyW + 4, h + 4);
        ctx.setLineDash([]);
      }
    });

    const hLine = (p: number, color: string, dash: number[], label: string) => {
      const ly = Math.round(y(p)) + 0.5;
      ctx.strokeStyle = color;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(plotW, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillRect(plotW + 1, ly - 9, AXIS_W - 1, 18);
      ctx.fillStyle = c.bg;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, plotW + 5, ly);
    };
    if (price !== null) hLine(price, c.text, [2, 3], formatPrice(price, decimals));
    if (activeTarget !== null) hLine(activeTarget, c.warn, [], formatPrice(activeTarget, decimals));
    if (editTarget !== null) hLine(editTarget, c.brand, [6, 4], formatPrice(editTarget, decimals));
  });

  /** Last candle's column, or the target line: what can be grabbed. */
  const hits = (px: number, py: number): boolean => {
    if (!canEdit || !scale || shown.length === 0) return false;
    const last = shown.at(-1) as Ohlc;
    const lx = xOf(shown.length - 1);
    const inColumn = Math.abs(px - lx) <= Math.max(10, slot);
    const inRange = py >= y(last.h) - 12 && py <= y(last.l) + 12;
    const onLine = editTarget !== null && Math.abs(py - y(editTarget)) <= 8 && px <= plotW;
    return (inColumn && inRange) || onLine;
  };

  const local = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const toPrice = (py: number) => (scale ? yToPrice(scale, PAD_T, plotH, Math.min(HEIGHT - PAD_B, Math.max(PAD_T, py))) : null);

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (!hits(p.x, p.y)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    frozen.current = scale;
    setDragging(true);
    const v = toPrice(p.y);
    if (v !== null) onTarget(v);
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (!dragging) {
      setHover(hits(p.x, p.y));
      return;
    }
    const v = toPrice(p.y);
    if (v !== null) onTarget(v);
  };
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    frozen.current = null;
    setDragging(false);
  };

  // Keyboard: arrows move the target by a small step (Shift: ×10), starting from the live price.
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!canEdit || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const base = editTarget ?? price;
    if (base === null) return;
    const tick = 10 ** -decimals;
    const stepP = Math.max(tick, roundTo(base * 0.0002, decimals)) * (e.shiftKey ? 10 : 1);
    onTarget(base + (e.key === 'ArrowUp' ? stepP : -stepP));
  };

  return (
    <div ref={wrapRef} className="w-full min-w-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width, height: HEIGHT, cursor: canEdit && (dragging || hover) ? 'ns-resize' : 'default', touchAction: 'none' }}
        tabIndex={canEdit ? 0 : -1}
        role="slider"
        aria-label="Preço de fechamento da vela atual"
        aria-valuenow={editTarget ?? price ?? undefined}
        aria-valuetext={editTarget !== null ? formatPrice(editTarget, decimals) : 'sem alvo'}
        aria-disabled={!canEdit}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => !dragging && setHover(false)}
        onKeyDown={onKey}
        className="block rounded-control"
      />
    </div>
  );
}
