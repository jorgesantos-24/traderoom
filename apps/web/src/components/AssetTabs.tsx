import { useEffect, useState } from 'react';
import { ASSET_CATEGORIES, type AssetCategory, type AssetView } from '@traderoom/shared';
import { formatPrice } from '../lib/format';
import { useFavorites } from '../lib/favorites';
import { useQuote } from '../lib/session-data';
import { Dialog } from './Dialog';
import { cx } from './ui';
import { CoinIcon } from './CoinIcon';
import { SearchField, StarButton } from './PickerControls';

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

const CATEGORY: Record<AssetCategory, string> = { crypto: 'Cripto', forex: 'Forex', stocks: 'Ações', synthetic: 'Sintéticos' };

/** Header tabs with the charts the user has open, plus a "+" to open another one. */
export function AssetTabs({ assets, tabs, active, onSelect, onClose, onOpen }: Props) {
  const [picking, setPicking] = useState(false);
  const [category, setCategory] = useState<AssetCategory | 'all' | 'fav'>('all');
  const [q, setQ] = useState('');
  const favorites = useFavorites('assets');
  // Each opening starts with an empty search.
  useEffect(() => {
    if (picking) setQ('');
  }, [picking]);
  const s = q.trim().toLowerCase();
  const matches = (a: AssetView) =>
    (category === 'all' || (category === 'fav' ? favorites.has(a.symbol) : a.category === category)) &&
    (!s || a.display.toLowerCase().includes(s) || a.symbol.toLowerCase().includes(s));
  // Favorites first, otherwise the server's order.
  const shown = assets.filter(matches).sort((a, b) => Number(favorites.has(b.symbol)) - Number(favorites.has(a.symbol)));
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));
  const open = tabs.map((s) => bySymbol.get(s)).filter((a): a is AssetView => a !== undefined);

  const squareBtn =
    'flex size-9 shrink-0 items-center justify-center rounded-[4px] border border-[#232c39] text-[#888b8f] transition-colors hover:border-[#3a4352] hover:text-text sm:size-[46px]';
  return (
    <>
      <button
        type="button"
        aria-label="Todos os ativos"
        title="Todos os ativos"
        onClick={() => setPicking(true)}
        className={cx(squareBtn, 'hidden md:flex')}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[26px]" fill="currentColor">
          <rect x="2" y="2" width="9" height="9" rx="1.6" />
          <rect x="13" y="2" width="9" height="9" rx="1.6" />
          <rect x="2" y="13" width="9" height="9" rx="1.6" />
          <rect x="13" y="13" width="9" height="9" rx="1.6" />
        </svg>
      </button>
      <div
        role="tablist"
        aria-label="Gráficos abertos"
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 self-stretch overflow-x-auto md:flex-initial md:items-end md:pb-[13px]"
      >
        {open.map((a) => {
          const selected = a.symbol === active;
          return (
            <div
              key={a.symbol}
              className={cx(
                'group relative flex h-[44px] shrink-0 items-center rounded-t-[3px] border-b-2 transition-colors md:h-[48px] md:w-[131px]',
                selected ? 'border-up bg-[#232c39]' : 'border-transparent hover:bg-[#1a2029]',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSelect(a.symbol)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2 pl-2.5 text-left leading-tight"
              >
                <CoinIcon symbol={a.symbol} className="size-[26px]" />
                <span className="flex min-w-0 flex-col items-start">
                  <span
                    className={cx(
                      'max-w-[78px] truncate text-[13px] font-bold',
                      selected ? 'text-text' : 'text-[#c3c6ca] group-hover:text-text',
                    )}
                  >
                    {a.display}
                    {a.kind === 'otc' && a.category !== 'synthetic' && a.category !== 'forex' && !/OTC/i.test(a.display) ? ' (OTC)' : ''}
                  </span>
                </span>
              </button>
              {open.length > 1 && (
                <button
                  type="button"
                  aria-label={`Fechar ${a.display}`}
                  onClick={() => onClose(a.symbol)}
                  className="flex h-full shrink-0 items-center rounded pr-2 pl-0.5 text-[12px] text-muted hover:text-text md:absolute md:top-0.5 md:right-0.5 md:hidden md:h-auto md:px-1 md:text-[10px] md:group-focus-within:block md:group-hover:block"
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
        className={cx(squareBtn, 'md:ml-3')}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M12 4v16M4 12h16" />
        </svg>
      </button>

      <Dialog open={picking} title="Escolha um ativo" onClose={() => setPicking(false)}>
        <SearchField value={q} onChange={setQ} label="Pesquisar ativo" />
        <div className="scrollbar-none flex gap-1 overflow-x-auto" role="group" aria-label="Categoria">
          {(['all', 'fav', ...ASSET_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cx(
                'shrink-0 rounded-control px-3 py-1 text-sm',
                category === c ? 'bg-field text-text' : 'text-muted hover:text-text',
              )}
            >
              {c === 'all' ? 'Todos' : c === 'fav' ? '★ Favoritos' : CATEGORY[c]}
            </button>
          ))}
        </div>
        <ul className="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto">
          {shown.map((a) => (
            <AssetRow
              key={a.symbol}
              asset={a}
              favorite={favorites.has(a.symbol)}
              onToggleFavorite={() => favorites.toggle(a.symbol)}
              onPick={() => {
                onOpen(a.symbol);
                setPicking(false);
              }}
            />
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted">
              {category === 'fav' && !s ? 'Nenhum favorito ainda. Toque na estrela ao lado de um ativo.' : 'Nenhum ativo encontrado.'}
            </li>
          )}
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

function AssetRow({
  asset,
  favorite,
  onToggleFavorite,
  onPick,
}: {
  asset: AssetView;
  favorite: boolean;
  onToggleFavorite(): void;
  onPick(): void;
}) {
  const quote = useQuote(asset.symbol);
  return (
    <li className="flex items-center gap-1 pl-1">
      <StarButton on={favorite} name={asset.display} onToggle={onToggleFavorite} />
      <button
        type="button"
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-control px-2 py-2.5 text-left hover:bg-field"
      >
        <CoinIcon symbol={asset.symbol} className="size-8" />
        <span className="flex-1">
          <span className="block text-sm font-semibold text-text">{asset.display}</span>
          <span className="tabular block text-xs text-muted">{quote?.price != null ? formatPrice(quote.price) : '—'}</span>
        </span>
        <span className="tabular text-sm font-bold text-up">{asset.payoutPct}%</span>
      </button>
    </li>
  );
}
