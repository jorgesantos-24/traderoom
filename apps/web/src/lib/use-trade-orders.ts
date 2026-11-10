import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetView, OrderView } from '@traderoom/shared';
import { api, ApiError } from './api';
import { serverClock } from './clock';
import { DIRECTION_LABEL, formatMoney, formatSignedMoney } from './format';
import { netCents, settleCheckAt, upsertOrders } from './orders';
import { useSessionData, type Loadable } from './session-data';
import { playLossSound, playWinSound } from './sound';

/** Asks for results this often in the first 2 s after an expiry (settled in ~0.1 s), then every second. */
const POLL_MS = 150;
const POLL_SLOW_MS = 1000;
const POLL_FAST_FOR_MS = 2000;
/** Result cards on screen at once; older ones drop off the stack. */
const RESULTS_MAX = 5;

/** One settled order's result card (and its bubble on the chart). */
export interface ResultToast {
  key: string;
  order: OrderView;
  display: string;
  /** Local time it was shown, for the chart bubble's lifetime. */
  shownAt: number;
}

/** Overall outcome of one settlement batch; decides which sound plays. */
export interface SettleResult {
  key: number;
  outcome: 'won' | 'lost' | 'void';
  netCents: number;
  count: number;
}

/** Sums a batch of settled orders into one popup (several can expire together). */
export function summarizeSettled(orders: readonly OrderView[], key: number): SettleResult {
  const net = orders.reduce((sum, o) => sum + netCents(o), 0);
  const allVoid = orders.every((o) => o.status === 'void');
  const outcome = allVoid ? 'void' : net > 0 || (net === 0 && orders.some((o) => o.status === 'won')) ? 'won' : 'lost';
  return { key, outcome, netCents: net, count: orders.length };
}

export function settledMessage(o: OrderView, display: string): string {
  const head = `Ordem ${DIRECTION_LABEL[o.direction]} em ${display} de ${formatMoney(o.stakeCents)}`;
  if (o.status === 'won') return `${head}: ganhou, ${formatSignedMoney(netCents(o))}.`;
  if (o.status === 'lost') return `${head}: perdeu, ${formatSignedMoney(netCents(o))}.`;
  return `${head}: anulada, valor devolvido.`;
}

/**
 * Open orders for the trading screen plus the ones settled during this visit.
 * There is no push for settlement, so once an order is past expiry + grace the
 * hook polls the newest orders until it sees the final status.
 */
export function useTradeOrders(assets: readonly AssetView[]) {
  const { account, refreshWallet } = useSessionData();
  const accountRef = useRef(account);
  accountRef.current = account;
  const [open, setOpen] = useState<Loadable<OrderView[]>>({ status: 'loading' });
  const [announcement, setAnnouncement] = useState('');
  const [results, setResults] = useState<ResultToast[]>([]);
  const [attempt, setAttempt] = useState(0);
  const polling = useRef(false);
  const lastPoll = useRef(0);
  const openRef = useRef<OrderView[]>([]);
  const displayRef = useRef(new Map<string, string>());
  displayRef.current = new Map(assets.map((a) => [a.symbol, a.display]));

  // Switching between real and demo starts over with that account's open orders.
  useEffect(() => {
    let cancelled = false;
    openRef.current = [];
    setOpen({ status: 'loading' });
    setResults([]);
    api.orders({ account, status: 'open', limit: 100 }).then(
      (page) => {
        if (cancelled) return;
        openRef.current = page.items;
        setOpen({ status: 'ready', data: page.items });
      },
      (err: unknown) => {
        if (!cancelled) setOpen({ status: 'error', message: err instanceof ApiError ? err.message : 'Erro ao carregar as ordens.' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, account]);

  const reload = useCallback(() => {
    setOpen({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const added = useCallback(
    (order: OrderView) => {
      openRef.current = upsertOrders(openRef.current, [order]);
      setOpen({ status: 'ready', data: openRef.current });
      const display = displayRef.current.get(order.symbol) ?? order.symbol;
      setAnnouncement(`Ordem ${DIRECTION_LABEL[order.direction]} de ${formatMoney(order.stakeCents)} aberta em ${display}.`);
      void refreshWallet();
    },
    [refreshWallet],
  );

  useEffect(() => {
    const id = setInterval(() => {
      const serverNow = serverClock.serverNow();
      const due = openRef.current.filter((o) => settleCheckAt(o) <= serverNow);
      if (due.length === 0 || polling.current) return;
      const fast = due.some((o) => serverNow - settleCheckAt(o) < POLL_FAST_FOR_MS);
      if (Date.now() - lastPoll.current < (fast ? 0 : POLL_SLOW_MS)) return;
      lastPoll.current = Date.now();
      polling.current = true;
      const polled = accountRef.current;
      api
        .orders({ account: polled, limit: 50 })
        .then((page) => {
          if (polled !== accountRef.current) return;
          const byId = new Map(page.items.map((o) => [o.id, o]));
          const settled = due.map((o) => byId.get(o.id)).filter((o): o is OrderView => o !== undefined && o.status !== 'open');
          if (settled.length === 0) return;
          const gone = new Set(settled.map((o) => o.id));
          openRef.current = openRef.current.filter((o) => !gone.has(o.id));
          setOpen({ status: 'ready', data: openRef.current });
          setAnnouncement(settled.map((o) => settledMessage(o, displayRef.current.get(o.symbol) ?? o.symbol)).join(' '));
          const now = Date.now();
          const summary = summarizeSettled(settled, now);
          const cards = settled.map((o) => ({ key: o.id, order: o, display: displayRef.current.get(o.symbol) ?? o.symbol, shownAt: now }));
          setResults((r) => [...cards, ...r].slice(0, RESULTS_MAX));
          if (summary.outcome === 'won') playWinSound();
          else if (summary.outcome === 'lost') playLossSound();
          void refreshWallet();
        })
        .catch(() => {
          // Next tick tries again.
        })
        .finally(() => {
          polling.current = false;
        });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refreshWallet]);

  const dismissResult = useCallback((key: string) => setResults((r) => r.filter((t) => t.key !== key)), []);

  return { open, announcement, results, dismissResult, added, reload };
}
