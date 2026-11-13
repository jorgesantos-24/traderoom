import { useSyncExternalStore } from 'react';

/** Starred items (assets, indicators), remembered on this device and shared by every component and tab. */
interface Store {
  ids: ReadonlySet<string>;
  listeners: Set<() => void>;
}

const stores = new Map<string, Store>();

function read(key: string): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function store(key: string): Store {
  let s = stores.get(key);
  if (!s) {
    s = { ids: read(key), listeners: new Set() };
    stores.set(key, s);
  }
  return s;
}

function toggle(key: string, id: string) {
  const s = store(key);
  const next = new Set(s.ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  s.ids = next;
  try {
    localStorage.setItem(key, JSON.stringify([...next]));
  } catch {
    // Not remembered in private mode.
  }
  s.listeners.forEach((l) => l());
}

function subscribe(key: string, listener: () => void) {
  const s = store(key);
  s.listeners.add(listener);
  // Another tab changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) {
      s.ids = read(key);
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    s.listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export type FavoriteKind = 'assets' | 'indicators';

export function useFavorites(kind: FavoriteKind) {
  const key = `traderoom:favorites:${kind}`;
  const ids = useSyncExternalStore(
    (l) => subscribe(key, l),
    () => store(key).ids,
  );
  return { ids, has: (id: string) => ids.has(id), toggle: (id: string) => toggle(key, id) };
}
