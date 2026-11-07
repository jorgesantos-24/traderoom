import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EMOJIS, TOOL_LABEL, type Tool } from '../lib/drawings';
import type { DrawingState } from '../lib/use-drawings';
import { cx } from './ui';

const P = (d: string) => <path d={d} />;

/** 24×24 line icons, drawn with currentColor. */
const ICON: Record<Tool | 'magnet' | 'stay' | 'lock' | 'hide' | 'trash' | 'undo', ReactNode> = {
  cross: P('M12 4v6M12 14v6M4 12h6M14 12h6'),
  pointer: P('M6 4l12 7-5.5 1.5L10 18z'),
  eraser: (
    <>
      {P('M4 16l8-8 6 6-6 6H8z')}
      {P('M9 11l6 6M12 20h8')}
    </>
  ),
  trend: (
    <>
      {P('M5 19L19 5')}
      <circle cx="5" cy="19" r="1.8" />
      <circle cx="19" cy="5" r="1.8" />
    </>
  ),
  ray: (
    <>
      {P('M5 19L21 3')}
      <circle cx="5" cy="19" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
    </>
  ),
  extended: (
    <>
      {P('M2 22L22 2')}
      <circle cx="8" cy="16" r="1.8" />
      <circle cx="16" cy="8" r="1.8" />
    </>
  ),
  hline: (
    <>
      {P('M2 12h20')}
      <circle cx="12" cy="12" r="1.8" />
    </>
  ),
  hray: (
    <>
      {P('M7 12h15')}
      <circle cx="6" cy="12" r="1.8" />
    </>
  ),
  vline: (
    <>
      {P('M12 2v20')}
      <circle cx="12" cy="12" r="1.8" />
    </>
  ),
  crossline: P('M12 2v20M2 12h20'),
  channel: P('M3 15L15 3M9 21L21 9'),
  fib: P('M3 5h18M3 9h18M3 12h18M3 15h18M3 19h18M5 19L19 5'),
  brush: P('M4 20c3 0 4-2 4-4l9-9a2 2 0 0 0-3-3l-9 9c-2 0-3 1-3 4M14 7l3 3'),
  highlighter: P('M5 19h6M9 15l-2 4M9 15l8-8 3 3-8 8zM15 9l3 3'),
  arrow: P('M5 19L19 5M11 5h8v8'),
  arrowUp: P('M12 4l6 7h-4v9h-4v-9H6z'),
  arrowDown: P('M12 20l6-7h-4V4h-4v9H6z'),
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="6" />,
  text: P('M5 6V4h14v2M12 4v16M9 20h6'),
  emoji: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M8.5 14.5c1.8 2 5.2 2 7 0')}
      <circle cx="9" cy="10" r="0.6" />
      <circle cx="15" cy="10" r="0.6" />
    </>
  ),
  ruler: P('M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2'),
  zoom: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      {P('M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6')}
    </>
  ),
  magnet: P('M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4'),
  stay: (
    <>
      {P('M4 20l1-4 10-10 3 3-10 10z')}
      <rect x="15" y="15" width="6" height="5" rx="1" />
      {P('M16.5 15v-1.5a1.5 1.5 0 0 1 3 0V15')}
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      {P('M8 11V7a4 4 0 0 1 8 0v4')}
    </>
  ),
  hide: (
    <>
      {P('M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z')}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  trash: P('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6'),
  undo: P('M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3'),
};

function Icon({ name, className }: { name: keyof typeof ICON; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cx('size-5', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON[name]}
    </svg>
  );
}

interface Group {
  id: string;
  title: string;
  tools: Tool[];
}

const GROUPS: Group[] = [
  { id: 'cursors', title: 'Cursores', tools: ['cross', 'pointer', 'eraser'] },
  {
    id: 'lines',
    title: 'Linhas',
    tools: ['trend', 'ray', 'extended', 'hline', 'hray', 'vline', 'crossline', 'channel'],
  },
  { id: 'fib', title: 'Fibonacci', tools: ['fib'] },
  {
    id: 'shapes',
    title: 'Pincéis, setas e formas',
    tools: ['brush', 'highlighter', 'arrow', 'arrowUp', 'arrowDown', 'rect', 'ellipse'],
  },
  { id: 'text', title: 'Texto', tools: ['text'] },
  { id: 'emoji', title: 'Emojis', tools: ['emoji'] },
  { id: 'ruler', title: 'Medir', tools: ['ruler'] },
  { id: 'zoom', title: 'Zoom', tools: ['zoom'] },
];

const btn = 'flex size-8 items-center justify-center rounded-control text-muted hover:bg-field hover:text-text';

/** Vertical drawing toolbar on the chart's left edge, like TradingView's. */
export function DrawingToolbar({ state, onClearAll }: { state: DrawingState; onClearAll(): void }) {
  // Last tool picked in each group: the group button shows and activates it.
  const [picked, setPicked] = useState<Record<string, Tool>>(() => Object.fromEntries(GROUPS.map((g) => [g.id, g.tools[0]!])));
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenGroup(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openGroup]);

  const choose = (g: Group, t: Tool) => {
    setPicked((p) => ({ ...p, [g.id]: t }));
    state.setTool(t);
    setOpenGroup(null);
  };

  const toggle = (label: string, icon: keyof typeof ICON, on: boolean, onClick: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cx(btn, on && 'bg-brand/10 text-brand hover:text-brand')}
    >
      <Icon name={icon} />
    </button>
  );

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Ferramentas de desenho"
      aria-orientation="vertical"
      className="flex flex-col items-center gap-0.5 py-1"
    >
      {GROUPS.map((g) => {
        const current = picked[g.id] ?? g.tools[0]!;
        const active = g.tools.includes(state.tool);
        const shown = active ? state.tool : current;
        const many = g.tools.length > 1 || g.id === 'emoji';
        return (
          <div key={g.id} className="group/tool relative">
            <button
              type="button"
              title={TOOL_LABEL[shown]}
              aria-label={TOOL_LABEL[shown]}
              aria-pressed={active}
              onClick={() => choose(g, shown)}
              className={cx(btn, active && 'bg-brand/10 text-brand hover:text-brand')}
            >
              {g.id === 'emoji' ? <span className="text-lg leading-none">{state.emoji}</span> : <Icon name={shown} />}
            </button>
            {many && (
              <button
                type="button"
                aria-label={`Mais: ${g.title}`}
                aria-haspopup="menu"
                aria-expanded={openGroup === g.id}
                onClick={() => setOpenGroup((o) => (o === g.id ? null : g.id))}
                className={cx(
                  'absolute top-0 -right-2 flex h-full w-2.5 items-center justify-center text-muted opacity-0 group-hover/tool:opacity-100 hover:text-text',
                  openGroup === g.id && 'opacity-100',
                )}
              >
                <svg aria-hidden="true" viewBox="0 0 8 12" className="h-2.5 w-1.5" fill="currentColor">
                  <path d="M1 1l5 5-5 5z" />
                </svg>
              </button>
            )}
            {openGroup === g.id && (
              <div
                role="menu"
                aria-label={g.title}
                className="absolute top-0 left-full z-40 ml-2 min-w-[210px] rounded-control border border-border bg-field py-1.5 shadow-2xl"
              >
                <div className="px-3 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">{g.title}</div>
                {g.id === 'emoji' ? (
                  <div className="grid grid-cols-4 gap-1 px-2 pb-1">
                    {EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        role="menuitem"
                        aria-label={`Emoji ${e}`}
                        onClick={() => {
                          state.setEmoji(e);
                          choose(g, 'emoji');
                        }}
                        className={cx('rounded p-1.5 text-xl hover:bg-surface', state.emoji === e && 'bg-brand/10')}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                ) : (
                  g.tools.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="menuitemradio"
                      aria-checked={state.tool === t}
                      onClick={() => choose(g, t)}
                      className={cx(
                        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm',
                        state.tool === t ? 'text-brand' : 'text-text hover:bg-surface',
                      )}
                    >
                      <Icon name={t} className="size-5" />
                      {TOOL_LABEL[t]}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="my-0.5 h-px w-6 bg-border" />
      {toggle('Ímã (encaixa nos preços da vela)', 'magnet', state.magnet, state.toggleMagnet)}
      {toggle('Continuar desenhando', 'stay', state.stay, state.toggleStay)}
      {toggle('Bloquear desenhos', 'lock', state.locked, state.toggleLocked)}
      {toggle('Ocultar desenhos', 'hide', state.hidden, state.toggleHidden)}
      <div className="my-0.5 h-px w-6 bg-border" />
      <button
        type="button"
        title="Desfazer (Ctrl+Z)"
        aria-label="Desfazer"
        disabled={!state.canUndo}
        onClick={state.undo}
        className={cx(btn, 'disabled:opacity-30 disabled:hover:bg-transparent')}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        title="Remover todos os desenhos"
        aria-label="Remover todos os desenhos"
        disabled={state.drawings.length === 0}
        onClick={onClearAll}
        className={cx(btn, 'hover:text-down disabled:opacity-30 disabled:hover:bg-transparent')}
      >
        <Icon name="trash" />
      </button>
    </div>
  );
}
