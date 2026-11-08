/**
 * Time labels for the price chart, in Brasília time (as TradingView shows it for Brazil).
 *
 * lightweight-charts picks its day/month/year tick marks on UTC boundaries, which are 21:00 in
 * Brasília. So intraday labels are worked out here: the tick that falls on local midnight shows
 * the date, every other one shows the time. Daily candles open at 00:00 UTC and are named by
 * that UTC date, as on TradingView.
 */
import { TIME_ZONE } from './format';

const DAY_MS = 86_400_000;

const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: TIME_ZONE });
const full = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: TIME_ZONE,
});
const utcDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const utcFull = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

/** Axis label for a tick at `sec` (unix seconds); `stepMs` is the candle interval. */
export function tickLabel(sec: number, stepMs: number): string {
  const d = new Date(sec * 1000);
  if (stepMs >= DAY_MS) return utcDay.format(d);
  const hhmm = time.format(d);
  return hhmm === '00:00' ? day.format(d) : hhmm;
}

/** Crosshair label: date and time, or just the date for daily candles. */
export function crosshairLabel(sec: number, stepMs: number): string {
  const d = new Date(sec * 1000);
  return stepMs >= DAY_MS ? utcFull.format(d) : full.format(d);
}
