import { useEffect, useMemo, useState, type RefObject } from 'react';
import { DRAW_COLORS } from '../lib/drawings';
import type { IndicatorRenderer, LegendPane } from '../lib/indicator-series';
import { INDICATOR_BY_TYPE, INDICATORS, indicatorLabel, type IndicatorConfig, type ParamDef } from '../lib/indicators';
import type { IndicatorsState } from '../lib/use-indicators';
import { Dialog } from './Dialog';
import { Button, cx } from './ui';

const CATEGORIES = ['Smart Money', 'Padrões', 'Tendência', 'Osciladores', 'Volatilidade'] as const;

const svg = (d: string) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    className="size-3.5"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);
const EYE = 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';
const EYE_OFF =
  'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 5.4-1.6';
const GEAR =
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';
const CLOSE = 'M6 6l12 12M18 6L6 18';

/** "ƒx" button that opens the indicator picker. */
export function IndicatorsButton({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      title="Indicadores"
      aria-label="Indicadores"
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-control font-serif text-[17px] text-muted italic hover:bg-field hover:text-text"
    >
      ƒ<span className="text-[11px] not-italic">x</span>
    </button>
  );
}

/** Picker: search and add indicators, grouped by category. */
export function IndicatorsDialog({ open, onClose, state }: { open: boolean; onClose(): void; state: IndicatorsState }) {
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  // Each opening starts with an empty search.
  useEffect(() => {
    if (open) setQ('');
  }, [open]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return INDICATORS.filter((d) => !s || d.name.toLowerCase().includes(s) || d.short.toLowerCase().includes(s));
  }, [q]);
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), 1200);
    return () => clearTimeout(t);
  }, [added]);

  return (
    <Dialog open={open} title="Indicadores" onClose={onClose}>
      <input
        autoFocus
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Pesquisar"
        aria-label="Pesquisar indicador"
        className="rounded-control border border-border bg-field px-3 py-2 text-sm text-text placeholder:text-muted focus:border-brand focus:outline-none"
      />
      <div className="-mx-2 max-h-[55vh] overflow-y-auto">
        {CATEGORIES.map((cat) => {
          const items = shown.filter((d) => d.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} className="mb-2">
              <div className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{cat}</div>
              {items.map((d) => {
                const count = state.list.filter((c) => c.type === d.type).length;
                return (
                  <button
                    key={d.type}
                    type="button"
                    onClick={() => {
                      state.add(d.type);
                      setAdded(d.type);
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-control px-2 py-2 text-left text-sm hover:bg-field"
                  >
                    <span>
                      {d.name}
                      <span className="ml-2 text-xs text-muted">{d.pane === 'main' ? 'no gráfico' : 'painel próprio'}</span>
                    </span>
                    <span className={cx('text-xs font-semibold', added === d.type ? 'text-up' : 'text-muted')}>
                      {added === d.type ? 'Adicionado ✓' : count > 0 ? `${count} no gráfico` : '+'}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {shown.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">Nenhum indicador encontrado.</p>}
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </Dialog>
  );
}

/** Settings of one indicator: parameters and line colors. */
export function IndicatorSettings({
  cfg,
  onClose,
  onSave,
}: {
  cfg: IndicatorConfig | null;
  onClose(): void;
  onSave(c: IndicatorConfig): void;
}) {
  const def = cfg ? INDICATOR_BY_TYPE.get(cfg.type) : undefined;
  const [params, setParams] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!cfg) return;
    setParams(Object.fromEntries(Object.entries(cfg.params).map(([k, v]) => [k, String(v)])));
    setColors({ ...cfg.colors });
  }, [cfg]);
  if (!cfg || !def) return <Dialog open={false} title="" onClose={onClose} children={null} />;

  const invalid = def.params.some((p) => {
    const n = Number(params[p.key]);
    return !Number.isFinite(n) || n < p.min || n > p.max;
  });
  const reset = () => {
    setParams(Object.fromEntries(def.params.map((p) => [p.key, String(p.default)])));
    setColors(Object.fromEntries(def.outputs.map((o) => [o.key, o.color])));
  };

  return (
    <Dialog open title={def.name} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid) return;
          onSave({ ...cfg, params: Object.fromEntries(def.params.map((p) => [p.key, Number(params[p.key])])), colors });
        }}
      >
        <div className="-mx-1 flex max-h-[58vh] flex-col gap-4 overflow-y-auto px-1">
          {groupParams(def.params).map(([group, list]) => (
            <section key={group ?? ''} className="flex flex-col gap-2">
              {group && <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{group}</h3>}
              <div className="grid grid-cols-2 gap-3">
                {list.map((p) => (
                  <ParamField key={p.key} p={p} value={params[p.key] ?? ''} onChange={(v) => setParams((s) => ({ ...s, [p.key]: v }))} />
                ))}
              </div>
            </section>
          ))}
          <section className="flex flex-col gap-2">
            {def.overlay && <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Cores</h3>}
            {def.outputs.map((o) => (
              <div key={o.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">{o.label}</span>
                <div className="flex gap-1.5">
                  {[o.color, ...DRAW_COLORS.filter((c) => c !== o.color)].slice(0, 8).map((col) => (
                    <button
                      key={col}
                      type="button"
                      aria-label={`Cor ${col} para ${o.label}`}
                      aria-pressed={colors[o.key] === col}
                      onClick={() => setColors((s) => ({ ...s, [o.key]: col }))}
                      className={cx('size-5 rounded-full border-2', colors[o.key] === col ? 'border-white' : 'border-transparent')}
                      style={{ background: col }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" type="button" onClick={reset}>
            Restaurar padrão
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={invalid}>
              Aplicar
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function groupParams(params: ParamDef[]): Array<[string | undefined, ParamDef[]]> {
  const out: Array<[string | undefined, ParamDef[]]> = [];
  for (const p of params) {
    const last = out.at(-1);
    if (last && last[0] === p.group) last[1].push(p);
    else out.push([p.group, [p]]);
  }
  return out;
}

function ParamField({ p, value, onChange }: { p: ParamDef; value: string; onChange(v: string): void }) {
  if (p.kind === 'toggle') {
    const on = Number(value) >= 0.5;
    return (
      <label className="col-span-2 flex cursor-pointer items-center justify-between gap-3 text-sm text-text">
        {p.label}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={p.label}
          onClick={() => onChange(on ? '0' : '1')}
          className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-brand' : 'bg-border')}
        >
          <span className={cx('absolute top-0.5 size-4 rounded-full bg-white transition-all', on ? 'left-[18px]' : 'left-0.5')} />
        </button>
      </label>
    );
  }
  if (p.kind === 'select') {
    return (
      <div className="col-span-2 flex items-center justify-between gap-3 text-sm text-text">
        <span>{p.label}</span>
        <div className="flex rounded-control border border-border bg-field p-0.5" role="radiogroup" aria-label={p.label}>
          {p.options!.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={Number(value) === o.value}
              onClick={() => onChange(String(o.value))}
              className={cx(
                'rounded px-2.5 py-1 text-xs font-semibold',
                Number(value) === o.value ? 'bg-brand text-black' : 'text-muted hover:text-text',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const n = Number(value);
  const bad = !Number.isFinite(n) || n < p.min || n > p.max;
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {p.label}
      <input
        type="number"
        inputMode="decimal"
        min={p.min}
        max={p.max}
        step={p.step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={bad}
        className={cx(
          'tabular rounded-control border bg-field px-3 py-2 text-sm text-text focus:outline-none',
          bad ? 'border-down' : 'border-border focus:border-brand',
        )}
      />
      {bad && (
        <span className="text-down">
          Entre {p.min} e {p.max}
        </span>
      )}
    </label>
  );
}

/** Legend at the top-left of each pane: name, live values, and hide / settings / remove. */
export function IndicatorLegend({
  rendererRef,
  hostRef,
  state,
  onSettings,
}: {
  rendererRef: RefObject<IndicatorRenderer | null>;
  hostRef: RefObject<HTMLDivElement | null>;
  state: IndicatorsState;
  onSettings(cfg: IndicatorConfig): void;
}) {
  const [panes, setPanes] = useState<LegendPane[]>([]);
  useEffect(() => {
    const tick = () => {
      const r = rendererRef.current;
      const host = hostRef.current;
      if (r && host) setPanes(r.legend(host));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [rendererRef, hostRef, state.list]);

  return (
    <>
      {panes.map((p) => (
        <div
          key={p.pane}
          className="pointer-events-none absolute left-2 z-[6] flex flex-col items-start gap-0.5"
          style={{ top: p.top + 6 }}
        >
          {p.items.map(({ cfg, values }) => (
            <div
              key={cfg.id}
              className="group/legend pointer-events-auto flex items-center gap-2 rounded px-1.5 py-0.5 text-xs hover:bg-field/90"
              data-testid="indicator-legend"
            >
              <span className={cx('font-medium', cfg.visible ? 'text-text' : 'text-muted line-through')}>{indicatorLabel(cfg)}</span>
              {cfg.visible &&
                values.map((v) => (
                  <span key={v.label} className="tabular font-semibold" style={{ color: v.color }} title={v.label}>
                    {v.text}
                  </span>
                ))}
              <span className="flex items-center gap-0.5 text-muted opacity-0 group-hover/legend:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={cfg.visible ? 'Ocultar' : 'Mostrar'}
                  title={cfg.visible ? 'Ocultar' : 'Mostrar'}
                  onClick={() => state.toggle(cfg.id)}
                  className="rounded p-0.5 hover:text-text"
                >
                  {svg(cfg.visible ? EYE : EYE_OFF)}
                </button>
                <button
                  type="button"
                  aria-label="Configurações"
                  title="Configurações"
                  onClick={() => onSettings(cfg)}
                  className="rounded p-0.5 hover:text-text"
                >
                  {svg(GEAR)}
                </button>
                <button
                  type="button"
                  aria-label="Remover"
                  title="Remover"
                  onClick={() => state.remove(cfg.id)}
                  className="rounded p-0.5 hover:text-down"
                >
                  {svg(CLOSE)}
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
