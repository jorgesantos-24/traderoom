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
import { brtAt } from '../src/worker/signal-strategy.js';
import { SIGNAL_DEFAULTS, TelegramSignals } from '../src/worker/telegram-signals.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SYMBOL = 'ZZSIGUSDT';
const DAY = '2030-01-02';
const START = brtAt(DAY, 8);
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
  // A steady uptrend every 5 s from 70 min before the session to 100 min after it.
  await pool.query(
    `insert into price_snapshots (asset_id, price, captured_at)
     select $1, 100 + n * 0.001 + (case when n % 7 = 0 then -0.002 else 0 end), $2::timestamptz + n * interval '5 seconds'
       from generate_series(0, 2040) n`,
    [assetId, new Date(START - 70 * 60_000)],
  );
});

afterAll(async () => {
  await clean();
  await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
});

describe('TelegramSignals', () => {
  it('runs a whole session once: announcement, 3 signals, their results and the report', async () => {
    const sent: Array<{ id: number; text: string; replyTo: number | null }> = [];
    const telegram: TelegramClient = {
      send: async (text, o) => {
        const id = sent.length + 1;
        sent.push({ id, text, replyTo: o?.replyTo ?? null });
        return id;
      },
    };
    let now = START - 16 * 60_000;
    const signals = new TelegramSignals(
      { pool, telegram, log: Fastify({ logger: false }).log, metrics: new Registry(), now: () => now },
      { ...SIGNAL_DEFAULTS, symbols: [SYMBOL], links: { signupUrl: 'https://x.test/register' } },
    );
    for (; now <= START + 75 * 60_000; now += 15_000) await signals.tick();
    // A restart replaying the same minutes posts nothing new.
    const before = sent.length;
    for (now = START - 16 * 60_000; now <= START + 75 * 60_000; now += 60_000) await signals.tick();
    expect(sent.length).toBe(before);

    expect(sent[0]!.text).toContain('Em <b>15 minutos</b> começa a sessão da <b>Manhã</b>');
    expect(sent[1]!.text).toContain('Iniciando sessão da <b>Manhã</b>');
    const posted = sent.filter((m) => m.text.includes('OPERAÇÃO CONFIRMADA'));
    expect(posted.map((m) => m.text.match(/Entrada às: <b>(\d\d:\d\d)/)![1])).toEqual(['08:10', '08:30', '08:50']);
    expect(posted.every((m) => m.text.includes('COMPRA'))).toBe(true);
    const results = sent.filter((m) => m.text.includes('WIN') && !m.text.includes('Relatório'));
    expect(results.map((m) => m.replyTo)).toEqual(posted.map((m) => m.id));
    const report = sent.at(-1)!.text;
    expect(report).toContain('Relatório da Sessão Manhã');
    expect(report).toContain('Wins: <b>3</b>');
    expect(report).toContain('Taxa de acerto: <b>100%</b>');

    const { rows } = await pool.query('select result, result_step, message_id from telegram_signals where day = $1 order by seq', [DAY]);
    expect(rows).toEqual(posted.map((m) => ({ result: 'win', result_step: 0, message_id: String(m.id) })));
  });
});
