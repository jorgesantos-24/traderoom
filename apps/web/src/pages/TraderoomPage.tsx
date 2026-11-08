import { useEffect, useMemo, useState } from 'react';
import type { AssetView, CandleInterval, OrderLimitsView } from '@traderoom/shared';
import { AppShell, StaleBanner } from '../components/AppShell';
import { AssetTabs } from '../components/AssetTabs';
import { OpenOrders } from '../components/OpenOrders';
import { OrderPanel } from '../components/OrderPanel';
import { CANDLE_LIMIT, PriceChart } from '../components/PriceChart';
import { TimeframePicker } from '../components/TimeframePicker';
import { prefetchCandles } from '../lib/candle-cache';
import { ResultToasts } from '../components/ResultPopup';
import { Card, EmptyState, ErrorState, LoadingState } from '../components/ui';
import { useFeedStatus, useQuote, useSessionData } from '../lib/session-data';
import { ASSET_PREF_KEY, OPEN_ASSET_EVENT } from '../lib/open-asset';
import { useTradeOrders } from '../lib/use-trade-orders';

const TIMEFRAMES: readonly CandleInterval[] = ['1m', '5m', '15m', '1h'];
const ASSET_KEY = ASSET_PREF_KEY;
const TF_KEY = 'traderoom.timeframe';
const TABS_KEY = 'traderoom.tabs';

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Open chart tabs kept from the last visit, dropping assets that no longer exist. */
function readTabs(symbols: readonly string[], current: string): string[] {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  const tabs = Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string' && symbols.includes(s)) : [];
  return tabs.includes(current) ? tabs : [...tabs, current];
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: preference just is not kept.
  }
}

export function TraderoomPage() {
  const { catalog, reloadCatalog } = useSessionData();
  if (catalog.status === 'loading') {
    return (
      <AppShell>
        <LoadingState label="Carregando ativos…" className="h-96" />
      </AppShell>
    );
  }
  if (catalog.status === 'error') {
    return (
      <AppShell>
        <ErrorState message={catalog.message} onRetry={reloadCatalog} className="h-96" />
      </AppShell>
    );
  }
  if (catalog.data.assets.length === 0) {
    return (
      <AppShell>
        <EmptyState
          title="Nenhum ativo disponível"
          hint="Os ativos estão temporariamente desativados. Volte em instantes."
          className="h-96"
        />
      </AppShell>
    );
  }
  return <Traderoom assets={catalog.data.assets} limits={catalog.data.limits} />;
}

function Traderoom({ assets, limits }: { assets: AssetView[]; limits: OrderLimitsView }) {
  const symbols = useMemo(() => assets.map((a) => a.symbol), [assets]);
  const [symbol, setSymbol] = useState(() => readPref(ASSET_KEY, symbols, symbols[0] as string));
  const [interval, setTimeframe] = useState<CandleInterval>(() => readPref(TF_KEY, TIMEFRAMES, '1m'));
  const asset = assets.find((a) => a.symbol === symbol) ?? (assets[0] as AssetView);
  const [tabs, setTabs] = useState(() => readTabs(symbols, asset.symbol));

  useEffect(() => writePref(ASSET_KEY, asset.symbol), [asset.symbol]);
  useEffect(() => writePref(TABS_KEY, JSON.stringify(tabs)), [tabs]);

  // Preload the charts most likely to be opened next: the other timeframes of this
  // asset and this timeframe for the other open tabs. Served from cache for a minute.
  useEffect(() => {
    const id = setTimeout(() => {
      prefetchCandles(
        [
          ...TIMEFRAMES.filter((tf) => tf !== interval).map((tf) => [asset.symbol, tf] as const),
          ...tabs.filter((s) => s !== asset.symbol).map((s) => [s, interval] as const),
        ],
        CANDLE_LIMIT,
      );
    }, 800);
    return () => clearTimeout(id);
  }, [asset.symbol, interval, tabs]);

  const openTab = (s: string) => {
    setTabs((t) => (t.includes(s) ? t : [...t, s]));
    setSymbol(s);
  };
  useEffect(() => {
    const onOpen = (e: Event) => {
      const s = (e as CustomEvent<string>).detail;
      if (!symbols.includes(s)) return;
      setTabs((t) => (t.includes(s) ? t : [...t, s]));
      setSymbol(s);
    };
    window.addEventListener(OPEN_ASSET_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ASSET_EVENT, onOpen);
  }, [symbols]);

  const closeTab = (s: string) => {
    if (tabs.length <= 1) return;
    const i = tabs.indexOf(s);
    const next = tabs.filter((x) => x !== s);
    setTabs(next);
    if (s === asset.symbol) setSymbol(next[Math.min(i, next.length - 1)] as string);
  };
  useEffect(() => writePref(TF_KEY, interval), [interval]);

  const { account, wallet } = useSessionData();
  const feedStatus = useFeedStatus();
  const quote = useQuote(asset.symbol);
  const orders = useTradeOrders(assets);
  const chartOrders = useMemo(
    () => (orders.open.status === 'ready' ? orders.open.data.filter((o) => o.symbol === asset.symbol) : []),
    [orders.open, asset.symbol],
  );

  const banner =
    feedStatus === 'reconnecting' || feedStatus === 'unauthorized'
      ? 'Conexão com as cotações perdida. Reconectando… Novas ordens estão bloqueadas.'
      : quote?.stale
        ? `Cotação de ${asset.display} defasada. Novas ordens neste ativo estão bloqueadas até o preço voltar.`
        : null;

  return (
    <AppShell
      fullBleed
      banner={<StaleBanner message={banner} />}
      headerExtra={<AssetTabs assets={assets} tabs={tabs} active={asset.symbol} onSelect={setSymbol} onClose={closeTab} onOpen={openTab} />}
    >
      <h1 className="sr-only">Negociar</h1>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="order-announcer">
        {orders.announcement}
      </div>
      <ResultToasts results={orders.results} onDismiss={orders.dismissResult} />
      <div className="grid gap-2 lg:h-full lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-h-0 min-w-0 flex-col">
          <Card className="flex flex-1 flex-col overflow-hidden">
            <div className="h-[calc(100svh-400px)] min-h-[220px] lg:h-auto lg:min-h-[320px] lg:flex-1">
              <PriceChart
                symbol={asset.symbol}
                display={asset.display}
                interval={interval}
                orders={chartOrders}
                results={orders.results}
                toolbarTop={<TimeframePicker value={interval} options={TIMEFRAMES} onChange={setTimeframe} />}
              />
            </div>
          </Card>
        </div>
        <div className="flex min-h-0 flex-col gap-2 lg:overflow-y-auto">
          <OrderPanel
            account={account}
            asset={asset}
            limits={limits}
            quote={quote}
            feedStatus={feedStatus}
            balanceCents={wallet.status === 'ready' ? wallet.data.balanceCents : null}
            onPlaced={orders.added}
          />
          <OpenOrders open={orders.open} assets={assets} onRetry={orders.reload} />
        </div>
      </div>
    </AppShell>
  );
}
