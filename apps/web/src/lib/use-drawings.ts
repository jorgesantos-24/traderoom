import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDrawings, saveDrawings, type Drawing, type Tool } from './drawings';

const UNDO_MAX = 50;

export interface DrawingState {
  tool: Tool;
  setTool(t: Tool): void;
  /** Emoji placed by the emoji tool. */
  emoji: string;
  setEmoji(e: string): void;
  drawings: readonly Drawing[];
  /** Replaces the list; `record` (default true) keeps the previous one for undo. */
  commit(next: readonly Drawing[], record?: boolean): void;
  undo(): void;
  canUndo: boolean;
  selectedId: string | null;
  select(id: string | null): void;
  magnet: boolean;
  toggleMagnet(): void;
  /** Keep the drawing tool after placing a drawing (otherwise back to the cursor). */
  stay: boolean;
  toggleStay(): void;
  locked: boolean;
  toggleLocked(): void;
  hidden: boolean;
  toggleHidden(): void;
}

/** Drawing tools and the drawings of one asset; drawings persist per asset in this browser. */
export function useDrawings(symbol: string): DrawingState {
  const [tool, setTool] = useState<Tool>('cross');
  const [emoji, setEmoji] = useState('🚀');
  const [drawings, setDrawings] = useState<readonly Drawing[]>(() => loadDrawings(symbol));
  const [selectedId, select] = useState<string | null>(null);
  const [magnet, setMagnet] = useState(false);
  const [stay, setStay] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const history = useRef<Array<readonly Drawing[]>>([]);
  const [canUndo, setCanUndo] = useState(false);
  const symbolRef = useRef(symbol);

  // Another asset: its own drawings and a fresh undo history.
  useEffect(() => {
    if (symbolRef.current === symbol) return;
    symbolRef.current = symbol;
    setDrawings(loadDrawings(symbol));
    select(null);
    history.current = [];
    setCanUndo(false);
  }, [symbol]);

  const current = useRef(drawings);
  current.current = drawings;

  const commit = useCallback((next: readonly Drawing[], record = true) => {
    if (record) {
      history.current.push(current.current);
      if (history.current.length > UNDO_MAX) history.current.shift();
      setCanUndo(true);
    }
    current.current = next;
    saveDrawings(symbolRef.current, next);
    setDrawings(next);
  }, []);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return;
    setCanUndo(history.current.length > 0);
    current.current = prev;
    saveDrawings(symbolRef.current, prev);
    setDrawings(prev);
    select(null);
  }, []);

  return {
    tool,
    setTool,
    emoji,
    setEmoji,
    drawings,
    commit,
    undo,
    canUndo,
    selectedId,
    select,
    magnet,
    toggleMagnet: () => setMagnet((v) => !v),
    stay,
    toggleStay: () => setStay((v) => !v),
    locked,
    toggleLocked: () => setLocked((v) => !v),
    hidden,
    toggleHidden: () => setHidden((v) => !v),
  };
}
