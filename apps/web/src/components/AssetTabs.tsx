import { useState } from 'react';
import { ASSET_CATEGORIES, type AssetCategory, type AssetView } from '@traderoom/shared';
import { formatPrice } from '../lib/format';
import { useQuote } from '../lib/session-data';
import { Dialog } from './Dialog';
import { cx } from './ui';
import { CoinIcon } from './CoinIcon';

interface Props {
  assets: readonly AssetView[];
  /** Symbols open as tabs, in order. */
  tabs: readonly string[];
  active: string;
  onSelect(symbol: string): void;
  onClose(symbol: string): void;
  /** Adds the symbol as a tab (if missing) and selects it. */
  onOpen(symbol: string): void;
}

const CATEGORY: Record<AssetCategory, string> = { crypto: 'Cripto', stocks: 'Ações', synthetic: 'Sintéticos' };
const TAB_LABEL: Record<AssetCategory, string> = { crypto: 'Cripto', stocks: 'Ação', synthetic: 'Sintético' };

/** Header tabs with the charts the user has open, plus a "+" to open another one. */
export function AssetTabs({ assets, tabs, active, onSelect, onClose, onOpen }: Props) {
  const [picking, setPicking] = useState(false);
  const [category, setCategory] = useState<AssetCategory | 'all'>('all');
  const shown = category === 'all' ? assets : assets.filter((a) => a.category === category);
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));
  const open = tabs.map((s) => bySymbol.get(s)).filter((a): a is AssetView => a !== undefined);

  return (
    <>
      <div role="tablist" aria-label="Gráficos abertos" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {open.map((a) => {
          const selected = a.symbol === active;
          return (
            <div
              key={a.symbol}
              className={cx(
                'group flex shrink-0 items-center rounded-control border',
                selected ? 'border-brand/60 bg-brand/10' : 'border-border bg-field hover:border-muted',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSelect(a.symbol)}
                className="flex items-center gap-2 py-1 pr-1 pl-2 leading-tight"
              >
                <CoinIcon symbol={a.symbol} className="size-6" />
                <span className="flex flex-col items-start">
                  <span className={cx('text-sm font-semibold', selected ? 'text-text' : 'text-muted group-hover:text-text')}>
                    {a.display}
                  </span>
                  <span className="text-[11px] font-semibold">
                    <span className="text-up">{a.payoutPct}%</span>
                    <span className="ml-1.5 text-muted uppercase">
                      {a.kind === 'otc' && a.category !== 'synthetic' ? 'OTC' : TAB_LABEL[a.category]}
                    </span>
                  </span>
                </span>
              </button>
              {open.length > 1 && (
                <button
                  type="button"
                  aria-label={`Fechar ${a.display}`}
                  onClick={() => onClose(a.symbol)}
                  className="mr-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-field hover:text-text"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Abrir outro gráfico"
        title="Abrir outro gráfico"
        onClick={() => setPicking(true)}
        className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-field text-xl font-semibold text-muted hover:border-brand hover:text-brand"
      >
        +
      </button>

      <Dialog open={picking} title="Escolha um ativo" onClose={() => setPicking(false)}>
        <div className="flex gap-1" role="group" aria-label="Categoria">
          {(['all', ...ASSET_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cx('rounded-control px-3 py-1 text-sm', category === c ? 'bg-field text-text' : 'text-muted hover:text-text')}
            >
              {c === 'all' ? 'Todos' : CATEGORY[c]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">
          {category === 'stocks'
            ? 'Ações OTC: preço gerado pela plataforma, disponível 24 horas, inclusive fins de semana. Não é a cotação da bolsa.'
            : category === 'synthetic'
              ? 'Índices sintéticos: preço gerado pela plataforma, 24 horas. Bull Market tende a subir e Bear Market a cair no longo prazo; no curto prazo o movimento é aleatório.'
              : 'Ativos com a etiqueta OTC têm preço gerado pela plataforma e funcionam 24 horas; os demais seguem a Binance.'}
        </p>
        <ul className="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto">
          {shown.map((a) => (
            <AssetRow
              key={a.symbol}
              asset={a}
              isOpen={tabs.includes(a.symbol)}
              onPick={() => {
                onOpen(a.symbol);
                setPicking(false);
              }}
            />
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setPicking(false)}
          className="self-end rounded-control px-3 py-1.5 text-sm text-muted hover:bg-field hover:text-text"
        >
          Fechar
        </button>
      </Dialog>
    </>
  );
}

function AssetRow({ asset, isOpen, onPick }: { asset: AssetView; isOpen: boolean; onPick(): void }) {
  const quote = useQuote(asset.symbol);
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left hover:bg-field"
      >
        <CoinIcon symbol={asset.symbol} className="size-8" />
        <span className="flex-1">
          <span className="block text-sm font-semibold text-text">
            {asset.display}
            {asset.kind === 'otc' && (
              <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                {asset.category === 'synthetic' ? 'Sintético' : 'OTC'}
              </span>
            )}
          </span>
          <span className="tabular block text-xs text-muted">{quote?.price != null ? formatPrice(quote.price) : '—'}</span>
        </span>
        {isOpen && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">Aberto</span>}
        <span className="tabular text-sm font-bold text-up">{asset.payoutPct}%</span>
      </button>
    </li>
  );
}
