import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '@traderoom/shared';
import { ApiError } from './api';

export interface Paged<T> {
  status: 'loading' | 'error' | 'ready';
  items: T[];
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  loadMore(): void;
  reload(): void;
  /** Rewrites loaded items in place, e.g. after an edit on one row. */
  patch(fn: (item: T) => T): void;
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Não foi possível carregar os dados.');

/** Cursor pagination with "load more". `key` changes (filters) restart from the first page. */
export function usePaged<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, key: string): Paged<T> {
  const [status, setStatus] = useState<Paged<T>['status']>('loading');
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    const gen = ++generation.current;
    setStatus('loading');
    setItems([]);
    setCursor(null);
    setMoreError(null);
    fetchRef.current().then(
      (page) => {
        if (gen !== generation.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus('ready');
      },
      (err: unknown) => {
        if (gen !== generation.current) return;
        setError(message(err));
        setStatus('error');
      },
    );
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    fetchRef.current(cursor).then(
      (page) => {
        if (gen !== generation.current) return;
        setItems((cur) => [...cur, ...page.items]);
        setCursor(page.nextCursor);
      },
      (err: unknown) => gen === generation.current && setMoreError(message(err)),
    ).finally(() => gen === generation.current && setLoadingMore(false));
  }, [cursor, loadingMore]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const patch = useCallback((fn: (item: T) => T) => setItems((cur) => cur.map(fn)), []);

  return { status, items, error, hasMore: cursor !== null, loadingMore, moreError, loadMore, reload, patch };
}
