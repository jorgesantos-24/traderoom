/** Lets any screen (e.g. the history panel) ask the trading page to open an asset tab. */
export const OPEN_ASSET_EVENT = 'kyden:open-asset';
export const ASSET_PREF_KEY = 'traderoom.asset';

export function requestOpenAsset(symbol: string): void {
  try {
    // Picked up on mount when the trading page is not on screen yet.
    localStorage.setItem(ASSET_PREF_KEY, symbol);
  } catch {
    // Private mode: the event below still covers the open page.
  }
  window.dispatchEvent(new CustomEvent<string>(OPEN_ASSET_EVENT, { detail: symbol }));
}
