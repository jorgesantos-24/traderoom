import { useSyncExternalStore } from 'react';
import { formatMoney } from './format';

/** "Ocultar saldos": one switch, remembered on this device, shared by every place that shows the user's own balance. */
const KEY = 'traderoom:hide-balance';
export const HIDDEN_MONEY = '••••••';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let hidden = read();

function set(next: boolean) {
  hidden = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    // Not remembered in private mode.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab toggled it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      hidden = read();
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useHideBalances() {
  const isHidden = useSyncExternalStore(subscribe, () => hidden);
  return {
    hidden: isHidden,
    toggle: () => set(!hidden),
    /** formatMoney, or the mask while hidden. */
    money: (cents: number) => (isHidden ? HIDDEN_MONEY : formatMoney(cents)),
  };
}
