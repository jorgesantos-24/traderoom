/** Flag set on login so the signed-in area opens behind the welcome screen. Kept for this tab only. */
const KEY = 'traderoom:splash';

export function requestSplash(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // No storage: the app opens without the welcome screen.
  }
}

export function splashRequested(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearSplash(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
