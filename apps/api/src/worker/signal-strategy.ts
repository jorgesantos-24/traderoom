// Pure parts of the Telegram signals: picking an asset and direction from 1-minute closes,
// deciding the result of a signal with protections, the schedule (Brasília time) and the texts.

import { escapeHtml } from '../lib/telegram.js';

export type Direction = 'call' | 'put';
export type SessionKey = 'manha' | 'tarde' | 'noite';

// ---------------------------------------------------------------------------------------------
// Indicators

export function ema(values: readonly number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0]! : values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI of the last value; null without enough data. */
export function rsi(values: readonly number[], n = 14): number | null {
  if (values.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export interface Candidate {
  assetId: number;
  direction: Direction;
  /** EMA gap in units of the average 1-minute move: how clear the trend is. */
  strength: number;
  /** Passed the RSI and momentum filters. */
  confirmed: boolean;
}

/**
 * Trend of one asset from its 1-minute closes (oldest first): EMA 9 against EMA 21, confirmed when
 * RSI 14 agrees without being stretched (call 50–70, put 30–50) and the last close is on the trend side
 * of EMA 9. Null without 30 closes or with a flat market.
 */
export function analyze(assetId: number, closes: readonly number[]): Candidate | null {
  if (closes.length < 30) return null;
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const last = closes.length - 1;
  const gap = e9[last]! - e21[last]!;
  let move = 0;
  for (let i = closes.length - 14; i <= last; i++) move += Math.abs(closes[i]! - closes[i - 1]!);
  move /= 14;
  if (move === 0 || gap === 0) return null;
  const direction: Direction = gap > 0 ? 'call' : 'put';
  const r = rsi(closes) ?? 50;
  const close = closes[last]!;
  const rsiOk = direction === 'call' ? r > 50 && r < 70 : r > 30 && r < 50;
  const momentumOk = direction === 'call' ? close > e9[last]! : close < e9[last]!;
  return { assetId, direction, strength: Math.abs(gap) / move, confirmed: rsiOk && momentumOk };
}

/**
 * Best candidate: confirmed ones first, then the clearest trend. Assets in `avoid` (already used in this
 * session) are only taken when nothing else qualifies.
 */
export function pickSignal(candidates: ReadonlyArray<Candidate | null>, avoid: ReadonlySet<number> = new Set()): Candidate | null {
  const list = candidates.filter((c): c is Candidate => c !== null);
  const rank = (c: Candidate) => (c.confirmed ? 1_000_000 : 0) + (avoid.has(c.assetId) ? -2_000_000 : 0) + c.strength;
  list.sort((a, b) => rank(b) - rank(a));
  return list[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Result

export interface StepPrices {
  open: number;
  close: number;
}
export type SignalResult = { result: 'win'; step: number } | { result: 'loss' | 'draw' | 'void'; step: number | null };

/**
 * Result of a signal from the prices of its steps (entry, then each protection, same direction).
 * `steps` holds what is known so far, in order; null = no price for that step. Returns null while
 * undecided (no win yet and steps still to come). A tie is refunded on the platform, so it moves on to
 * the next protection; a tie on the last step is a draw.
 */
export function decideSignal(direction: Direction, gales: number, steps: ReadonlyArray<StepPrices | null>): SignalResult | null {
  for (let k = 0; k < steps.length && k <= gales; k++) {
    const s = steps[k];
    if (!s) return { result: 'void', step: k };
    const up = s.close > s.open;
    const down = s.close < s.open;
    if ((direction === 'call' && up) || (direction === 'put' && down)) return { result: 'win', step: k };
    if (k === gales) return { result: up || down ? 'loss' : 'draw', step: k };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Schedule (Brasília, UTC-3 all year since 2019)

const BRT_OFFSET_MS = -3 * 3_600_000;

/** reminderPhoto: path under the site origin of the image sent with the 15-minute reminder. */
export const SESSIONS: ReadonlyArray<{ key: SessionKey; name: string; hour: number; reminderPhoto?: string }> = [
  { key: 'manha', name: 'Manhã', hour: 9, reminderPhoto: '/telegram/manha.jpg' },
  { key: 'tarde', name: 'Tarde', hour: 15, reminderPhoto: '/telegram/tarde.jpg' },
  { key: 'noite', name: 'Noite', hour: 21, reminderPhoto: '/telegram/noite.jpg' },
];

export interface ScheduleOptions {
  /** Minutes after the session start of each entry. */
  entryOffsetsMin: readonly number[];
  /** The signal is posted this long before its entry. */
  leadMs: number;
}

/**
 * 4 M5 entries, one every 20 minutes from 09:05, each posted 2 minutes before. An entry plus 2 protections
 * takes 15 minutes, and the next signal waits for that result, so 20 minutes is the tightest spacing.
 */
export const SCHEDULE_DEFAULTS: ScheduleOptions = { entryOffsetsMin: [5, 25, 45, 65], leadMs: 2 * 60_000 };

/** 'YYYY-MM-DD' of the Brasília day containing `ms`. */
export function brtDay(ms: number): string {
  return new Date(ms + BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of `hour`:00 Brasília time on `day`. */
export function brtAt(day: string, hour: number, minute = 0): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hour, minute) - BRT_OFFSET_MS;
}

export function brtHHMM(ms: number): string {
  return new Date(ms + BRT_OFFSET_MS).toISOString().slice(11, 16);
}

export function brtDDMM(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

// ---------------------------------------------------------------------------------------------
// Texts (Telegram HTML)

export interface Links {
  signupUrl: string;
}

const ORDINAL = ['1ª', '2ª', '3ª'];

function footer(links: Links): string {
  return `🔗 <a href="${escapeHtml(links.signupUrl)}">Cadastre-se na corretora!</a>`;
}

export function reminderText(sessionName: string): string {
  return `🔔 Em <b>15 minutos</b> começa a sessão da <b>${sessionName}</b>!

Prepare sua banca e fique de olho no canal. 📊`;
}

function expiryLabel(sec: number): string {
  const m = Math.round(sec / 60);
  return m === 1 ? '1 MINUTO (M1)' : `${m} MINUTOS (M${m})`;
}

/** Fixed weekly posts: on these Brasília weekdays (0 = Sunday) at hour:minute, a photo with a caption. */
export interface WeeklyPost {
  key: string;
  weekdays: readonly number[];
  hour: number;
  minute: number;
  /** Path under the site origin, e.g. /telegram/corujao.jpg. */
  photoPath: string | null;
  caption: string;
}

export const WEEKLY_POSTS: readonly WeeklyPost[] = [
  {
    key: 'corujao',
    weekdays: [1, 3, 4], // Monday, Wednesday, Thursday
    hour: 21,
    minute: 0,
    photoPath: '/telegram/corujao.jpg',
    caption: [
      '🦉 <b>SESSÃO DO CORUJÃO</b> 🌙',
      '',
      'Daqui a <b>1 hora</b> começa a sessão do Corujão com o <b>Trader Jorge</b>! Vamos atrás das <b>melhores movimentações do mercado</b>. 📈',
      '',
      'Quer fazer parte? 👥',
      'Manda mensagem agora para 👉 @JorgeTrader25',
    ].join('\n'),
  },
];

/** Brasília weekday (0 = Sunday) of a 'YYYY-MM-DD' day. */
export function brtWeekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export function announceText(sessionName: string): string {
  return `⏳ Iniciando sessão da <b>${sessionName}</b> em alguns minutos...\n\nFique atento às entradas! 📊`;
}

export function signalText(s: { display: string; direction: Direction; entryAt: number; expirySec: number; gales: number }, links: Links): string {
  const analysis = s.direction === 'call' ? '🟢 COMPRA ⬆️' : '🔴 VENDA ⬇️';
  const lines = [
    '📊 <b>OPERAÇÃO CONFIRMADA</b> 📊',
    '',
    `📈 Ativo: <b>${escapeHtml(s.display)}</b>`,
    `⏰ Entrada às: <b>${brtHHMM(s.entryAt)}</b>`,
    `⌛ Expiração: <b>${expiryLabel(s.expirySec)}</b>`,
    `📌 Análise: <b>${analysis}</b>`,
  ];
  if (s.gales > 0) {
    lines.push('', `🛡 Até ${s.gales} ${s.gales === 1 ? 'proteção' : 'proteções'}, se necessário!`);
    for (let k = 1; k <= s.gales; k++) lines.push(`${ORDINAL[k - 1]} Proteção às: ${brtHHMM(s.entryAt + k * s.expirySec * 1000)}`);
    lines.push('Obs: entrar 1s antes dos horários acima.', '', '⚠️ Cada proteção aumenta o valor em risco. Opere com responsabilidade.');
  } else {
    lines.push('', 'Obs: entrar 1s antes do horário acima.');
  }
  lines.push('', footer(links));
  return lines.join('\n');
}

export function resultLabel(r: { result: string; result_step: number | null }): string {
  if (r.result === 'win') return r.result_step ? `✅ WIN na ${ORDINAL[r.result_step - 1]} proteção` : '✅ WIN';
  if (r.result === 'loss') return '❌ LOSS';
  if (r.result === 'draw') return '⚪ EMPATE (valor devolvido)';
  return '⚠️ ANULADA (sem cotação)';
}

export function resultText(r: { display: string; result: string; result_step: number | null }): string {
  return `<b>${resultLabel(r)}</b> — ${escapeHtml(r.display)}`;
}

type ReportRow = { display: string; entry_at: Date; direction: Direction; result: string; result_step: number | null };

export function reportText(sessionName: string, day: string, rows: ReadonlyArray<ReportRow>, links: Links): string {
  return summary(`📋 <b>Relatório da Sessão ${sessionName}</b> — ${brtDDMM(day)}`, rows, links);
}

export function stopLossText(sessionName: string, day: string, rows: ReadonlyArray<ReportRow>, losses: number, links: Links): string {
  const head = [
    '🛑 <b>STOP LOSS ATINGIDO</b> 🛑',
    '',
    `Batemos ${losses} loss e a sessão da <b>${sessionName}</b> foi encerrada por aqui. Gerenciamento em primeiro lugar!`,
    'Voltamos na próxima sessão. 💪',
    '',
    `📋 <b>Resumo da Sessão ${sessionName}</b> — ${brtDDMM(day)}`,
  ].join('\n');
  return summary(head, rows, links);
}

function summary(head: string, rows: ReadonlyArray<ReportRow>, links: Links): string {
  const wins = rows.filter((r) => r.result === 'win').length;
  const losses = rows.filter((r) => r.result === 'loss').length;
  const decided = wins + losses;
  const lines = [head, ''];
  for (const r of rows) {
    const icon = r.result === 'win' ? '✅' : r.result === 'loss' ? '❌' : r.result === 'draw' ? '⚪' : '⚠️';
    // Only the outcome: no direction, no protection step.
    lines.push(`${brtHHMM(r.entry_at.getTime())} ${escapeHtml(r.display)} ${icon}`);
  }
  lines.push(
    '',
    `✅ Wins: <b>${wins}</b>`,
    `❌ Loss: <b>${losses}</b>`,
    `📊 Total de operações: <b>${rows.length}</b>`,
    `🎯 Taxa de acerto: <b>${decided ? Math.round((wins / decided) * 100) : 0}%</b>`,
    '',
    footer(links),
  );
  return lines.join('\n');
}
