// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { Registry } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import type { TelegramClient } from '../src/lib/telegram.js';
import { WEEKLY_POSTS, brtAt } from '../src/worker/signal-strategy.js';
import { SIGNAL_DEFAULTS, TelegramSignals } from '../src/worker/telegram-signals.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SYMBOL = 'ZZSIGUSDT';
const DAY = '2030-01-02';
const START = brtAt(DAY, 9);
let pool: pg.Pool;
let assetId: number;

async function clean(): Promise<void> {
  await pool.query('delete from telegram_signals where day = $1', [DAY]);
  await pool.query('delete from telegram_signal_sessions where day = $1', [DAY]);
}

beforeAll(async () => {
  pool = createPool(loadConfig());
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, enabled, sort) values ($1, 'ZZSIG/USD', 'zzsigusdt@bookTicker', true, 9995)
     on conflict (symbol) do update set enabled = true returning id`,
    [SYMBOL],
  );
  assetId = rows[0]!.id;
  await clean();
  await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
  // A steady uptrend every 5 s from 210 min before the session (40 five-minute candles) to 100 min after it.
  await pool.query(
    `insert into price_snapshots (asset_id, price, captured_at)
     select $1, 100 + n * 0.001 + (case when n % 7 = 0 then -0.002 else 0 end), $2::timestamptz + n * interval '5 seconds'
       from generate_series(0, 3720) n`,
    [assetId, new Date(START - 210 * 60_000)],
  );
});

afterAll(async () => {
  await clean();
  await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
});

describe('TelegramSignals', () => {
  it('runs a whole session once: reminder, announcement, 4 M5 signals, their results and the report', async () => {
    const sent: Array<{ id: number; text: string; replyTo: number | null }> = [];
    const telegram: TelegramClient = {
      send: async (text, o) => {
        const id = sent.length + 1;
        sent.push({ id, text, replyTo: o?.replyTo ?? null });
        return id;
      },
      sendPhoto: async (url, caption) => {
        const id = sent.length + 1;
        sent.push({ id, text: `[photo ${url}] ${caption}`, replyTo: null });
        return id;
      },
      sendSticker: async (fileId, o) => {
        const id = sent.length + 1;
        sent.push({ id, text: `[sticker ${fileId}]`, replyTo: o?.replyTo ?? null });
        return id;
      },
    };
    let now = START - 16 * 60_000;
    const signals = new TelegramSignals(
      { pool, telegram, log: Fastify({ logger: false }).log, metrics: new Registry(), now: () => now },
      { ...SIGNAL_DEFAULTS, symbols: [SYMBOL], links: { signupUrl: 'https://x.test/register' }, publicOrigin: 'https://x.test', weeklyPosts: [] },
    );
    for (; now <= START + 90 * 60_000; now += 15_000) await signals.tick();
    // A restart replaying the same minutes posts nothing new.
    const before = sent.length;
    for (now = START - 16 * 60_000; now <= START + 90 * 60_000; now += 60_000) await signals.tick();
    expect(sent.length).toBe(before);

    expect(sent[0]!.text).toContain('[photo https://x.test/telegram/manha.jpg] ');
    expect(sent[0]!.text).toContain('Em <b>15 minutos</b> começa a sessão da <b>Manhã</b>');
    expect(sent[1]!.text).toContain('Iniciando sessão da <b>Manhã</b>');
    const posted = sent.filter((m) => m.text.includes('OPERAÇÃO CONFIRMADA'));
    expect(posted.map((m) => m.text.match(/Entrada às: <b>(\d\d:\d\d)/)![1])).toEqual(['09:05', '09:15', '09:25', '09:35']);
    expect(posted.every((m) => m.text.includes('COMPRA') && m.text.includes('5 MINUTOS (M5)'))).toBe(true);
    expect(posted[0]!.text).toContain('1ª Proteção às: 09:10');
    expect(posted[0]!.text).toContain('2ª Proteção às: 09:15');
    const results = sent.filter((m) => m.text.startsWith('[sticker '));
    expect(results.every((m) => m.text === `[sticker ${SIGNAL_DEFAULTS.resultStickers.win}]`)).toBe(true);
    // Each win sticker is followed by the "Green" cheer.
    expect(results.every((m) => sent[m.id]!.text === '<b>Green</b> ✅✅✅✅✅')).toBe(true);
    expect(results.map((m) => m.replyTo)).toEqual(posted.map((m) => m.id));
    const report = sent.at(-1)!.text;
    expect(report).toContain('Relatório da Sessão Manhã');
    expect(report).toContain('Wins: <b>4</b>');
    expect(report).toContain('Taxa de acerto: <b>100%</b>');

    const { rows } = await pool.query('select result, result_step, message_id from telegram_signals where day = $1 order by seq', [DAY]);
    expect(rows).toEqual(posted.map((m) => ({ result: 'win', result_step: 0, message_id: String(m.id) })));
  });

  it('stops the session at 2 losses: stop message, no more signals, no report', async () => {
    await clean();
    for (const seq of [1, 2]) {
      await pool.query(
        `insert into telegram_signals (day, session, seq, asset_id, display, direction, entry_at, expiry_sec, gales, result, result_step, resolved_at)
         values ($1, 'manha', $2, $3, 'ZZSIG/USD', 'put', $4, 60, 2, 'loss', 2, now())`,
        [DAY, seq, assetId, new Date(START + (seq * 20 - 15) * 60_000)],
      );
    }
    await pool.query(`insert into telegram_signal_sessions (day, session, reminded_at, announced_at) values ($1, 'manha', now(), now())`, [DAY]);
    const sent: string[] = [];
    let now = START + 40 * 60_000;
    const signals = new TelegramSignals(
      {
        pool,
        telegram: { send: async (text) => (sent.push(text), sent.length), sendPhoto: async () => 0, sendSticker: async () => 0 },
        log: Fastify({ logger: false }).log,
        metrics: new Registry(),
        now: () => now,
      },
      { ...SIGNAL_DEFAULTS, symbols: [SYMBOL], links: { signupUrl: 'https://x.test/register' }, publicOrigin: 'https://x.test', weeklyPosts: [] },
    );
    for (; now <= START + 90 * 60_000; now += 15_000) await signals.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('STOP LOSS ATINGIDO');
    expect(sent[0]).toContain('Loss: <b>2</b>');
    const { rows } = await pool.query('select count(*)::int n from telegram_signals where day = $1', [DAY]);
    expect(rows[0].n).toBe(2);
  });

  it('posts the Corujão photo once at 21:00 on Monday, Wednesday and Thursday', async () => {
    await clean();
    await pool.query('delete from telegram_posts where day = $1', [DAY]);
    const photos: Array<[string, string]> = [];
    let now = brtAt(DAY, 20, 58); // 2030-01-02 is a Wednesday
    const signals = new TelegramSignals(
      {
        pool,
        telegram: { send: async () => 1, sendPhoto: async (url, caption) => (photos.push([url, caption]), photos.length), sendSticker: async () => 1 },
        log: Fastify({ logger: false }).log,
        metrics: new Registry(),
        now: () => now,
      },
      { ...SIGNAL_DEFAULTS, symbols: [SYMBOL], links: { signupUrl: 'https://x.test/register' }, publicOrigin: 'https://x.test/', weeklyPosts: WEEKLY_POSTS },
    );
    for (; now <= brtAt(DAY, 21, 10); now += 15_000) await signals.tick();
    expect(photos).toHaveLength(1);
    expect(photos[0]![0]).toBe('https://x.test/telegram/corujao.jpg');
    expect(photos[0]![1]).toContain('Daqui a <b>1 hora</b>');
    expect(photos[0]![1]).toContain('@JorgeTrader25');
    await pool.query('delete from telegram_posts where day = $1', [DAY]);
  });
});
