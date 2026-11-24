import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Counter, Registry } from '@traderoom/shared';
import type { TelegramClient } from '../lib/telegram.js';
import {
  SCHEDULE_DEFAULTS,
  SESSIONS,
  WEEKLY_POSTS,
  brtWeekday,
  analyze,
  announceText,
  reminderText,
  brtAt,
  brtDay,
  decideSignal,
  pickSignal,
  reportText,
  resultText,
  signalText,
  stopLossText,
  type Direction,
  type Links,
  type ScheduleOptions,
  type StepPrices,
  type WeeklyPost,
} from './signal-strategy.js';

export interface SignalOptions extends ScheduleOptions {
  /** Symbols the signals may use (enabled ones only). */
  symbols: readonly string[];
  expirySec: number;
  gales: number;
  tickMs: number;
  /** Losses that end a session early (0 = never). */
  stopLoss: number;
  links: Links;
  /** Site origin for photo URLs (https://kydeninvest.com). */
  publicOrigin: string;
  weeklyPosts: readonly WeeklyPost[];
  /** Sticker file_ids posted instead of the result text (draws and voids keep the text). */
  resultStickers: { win: string; loss: string };
}

export interface SignalDeps {
  pool: pg.Pool;
  telegram: TelegramClient;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  metrics: Registry;
  now?: () => number;
}

/** A snapshot counts as the price at t only if it is at most this old (same rule as settlement). */
const PRICE_WINDOW_SEC = 10;
/** Wait after a step ends so its closing snapshot is in the database. */
const SETTLE_DELAY_MS = 3_000;
/** The announcement is only posted in the first minutes of a session (not after a long downtime). */
const ANNOUNCE_WINDOW_MS = 4 * 60_000;
/** The reminder goes out this long before a session starts. */
const REMINDER_BEFORE_MS = 15 * 60_000;
/** Sent right after the win sticker. */
const WIN_CHEER = '<b>Green</b> ✅✅✅✅✅';
/** A signal is not posted when its entry is closer than this. */
const MIN_NOTICE_MS = 60_000;

/**
 * Posts the daily signals to Telegram: per session an announcement, one signal before each entry,
 * the real result of each signal (platform prices, same rule as order settlement) as a reply to it,
 * and a report once all are decided. State lives in Postgres; each message is claimed by a row
 * before sending, so restarts never repeat one (a send that fails is logged and skipped).
 */
export class TelegramSignals {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly sent: Counter;
  private readonly failed: Counter;

  constructor(
    private readonly deps: SignalDeps,
    private readonly opts: SignalOptions,
  ) {
    this.sent = deps.metrics.counter('telegram_messages_sent_total', 'Messages posted to the Telegram signals channel.');
    this.failed = deps.metrics.counter('telegram_messages_failed_total', 'Telegram signal messages that failed to send.');
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One pass over today's sessions. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const day = brtDay(now);
      for (const s of SESSIONS) {
        const start = brtAt(day, s.hour);
        if (now >= start - REMINDER_BEFORE_MS && now < start - REMINDER_BEFORE_MS + ANNOUNCE_WINDOW_MS) await this.remind(day, s.key, s.name, s.reminderPhoto);
        if (now < start) continue;
        if (now < start + ANNOUNCE_WINDOW_MS) await this.announce(day, s.key, s.name);
        for (let i = 0; i < this.opts.entryOffsetsMin.length; i++) {
          const entryAt = start + this.opts.entryOffsetsMin[i]! * 60_000;
          if (now >= entryAt - this.opts.leadMs && now < entryAt - MIN_NOTICE_MS) await this.post(day, s.key, i + 1, entryAt);
        }
      }
      for (const p of this.opts.weeklyPosts) {
        const at = brtAt(day, p.hour, p.minute);
        if (p.weekdays.includes(brtWeekday(day)) && now >= at && now < at + ANNOUNCE_WINDOW_MS) await this.weekly(day, p);
      }
      await this.resolve(now);
      for (const s of SESSIONS) {
        if (now >= brtAt(day, s.hour)) await this.stopLoss(day, s.key, s.name);
      }
      for (const s of SESSIONS) {
        const lastEntry = brtAt(day, s.hour) + Math.max(...this.opts.entryOffsetsMin) * 60_000;
        if (now >= lastEntry) await this.report(day, s.key, s.name);
      }
    } catch (err) {
      this.deps.log.error({ err }, 'telegram signals tick failed');
    } finally {
      this.running = false;
    }
  }

  private async send(what: string, text: string, replyTo?: number | null): Promise<number | null> {
    try {
      const id = await this.deps.telegram.send(text, { replyTo });
      this.sent.inc({ kind: what });
      return id;
    } catch (err) {
      this.failed.inc({ kind: what });
      this.deps.log.error({ err: (err as Error).message, what }, 'telegram send failed');
      return null;
    }
  }

  private async remind(day: string, session: string, name: string, photo?: string): Promise<void> {
    const r = await this.deps.pool.query(
      `insert into telegram_signal_sessions (day, session, reminded_at) values ($1, $2, now())
       on conflict (day, session) do update set reminded_at = now() where telegram_signal_sessions.reminded_at is null
       returning 1`,
      [day, session],
    );
    if (r.rowCount) await this.photoOrText('reminder', photo ?? null, reminderText(name));
  }

  private async weekly(day: string, p: WeeklyPost): Promise<void> {
    const r = await this.deps.pool.query('insert into telegram_posts (day, key) values ($1, $2) on conflict do nothing returning 1', [day, p.key]);
    if (!r.rowCount) return;
    await this.photoOrText(`post_${p.key}`, p.photoPath, p.caption);
  }

  /** Photo with the text as caption; if the photo fails, the text alone. */
  private async photoOrText(what: string, photoPath: string | null, text: string): Promise<void> {
    if (photoPath) {
      try {
        await this.deps.telegram.sendPhoto(`${this.opts.publicOrigin.replace(/\/$/, '')}${photoPath}`, text);
        this.sent.inc({ kind: what });
        return;
      } catch (err) {
        this.failed.inc({ kind: `${what}_photo` });
        this.deps.log.warn({ err: (err as Error).message, what }, 'telegram photo failed; sending the text only');
      }
    }
    await this.send(what, text);
  }

  private async announce(day: string, session: string, name: string): Promise<void> {
    const r = await this.deps.pool.query(
      `insert into telegram_signal_sessions (day, session, announced_at) values ($1, $2, now())
       on conflict (day, session) do update set announced_at = now() where telegram_signal_sessions.announced_at is null
       returning 1`,
      [day, session],
    );
    if (r.rowCount) await this.send('announce', announceText(name));
  }

  private async post(day: string, session: string, seq: number, entryAt: number): Promise<void> {
    const exists = await this.deps.pool.query('select 1 from telegram_signals where day = $1 and session = $2 and seq = $3', [day, session, seq]);
    if (exists.rowCount) return;
    // Stopped sessions post nothing more; and a signal waits for the previous one's result, so the stop
    // loss is known before the next entry goes out.
    const gate = await this.deps.pool.query<{ stopped: boolean; open: boolean; losses: number }>(
      `select exists (select 1 from telegram_signal_sessions where day = $1 and session = $2 and stopped_at is not null) as stopped,
              exists (select 1 from telegram_signals where day = $1 and session = $2 and seq < $3 and result is null) as open,
              (select count(*)::int from telegram_signals where day = $1 and session = $2 and result = 'loss') as losses`,
      [day, session, seq],
    );
    const g = gate.rows[0];
    if (!g || g.stopped || g.open || (this.opts.stopLoss > 0 && g.losses >= this.opts.stopLoss)) return;

    const { rows: assets } = await this.deps.pool.query<{ id: number; display: string }>(
      'select id, display from assets where enabled and symbol = any($1::text[])',
      [this.opts.symbols],
    );
    if (assets.length === 0) {
      this.deps.log.warn({ symbols: this.opts.symbols }, 'telegram signals: no enabled asset to use');
      return;
    }
    const now = this.now();
    const { rows: candles } = await this.deps.pool.query<{ asset_id: number; c: string }>(
      `select asset_id, (array_agg(price order by captured_at desc))[1]::text as c
         from price_snapshots
        where asset_id = any($1::int[]) and captured_at >= $2 and captured_at < $3
        group by asset_id, date_bin(interval '1 minute', captured_at, timestamptz 'epoch')
        order by asset_id, date_bin(interval '1 minute', captured_at, timestamptz 'epoch')`,
      [assets.map((a) => a.id), new Date(now - 60 * 60_000), new Date(now)],
    );
    const closes = new Map<number, number[]>();
    for (const c of candles) {
      const list = closes.get(c.asset_id) ?? [];
      list.push(Number(c.c));
      closes.set(c.asset_id, list);
    }
    const { rows: used } = await this.deps.pool.query<{ asset_id: number }>(
      'select asset_id from telegram_signals where day = $1 and session = $2',
      [day, session],
    );
    const pick = pickSignal(
      assets.map((a) => analyze(a.id, closes.get(a.id) ?? [])),
      new Set(used.map((u) => u.asset_id)),
    );
    if (!pick) {
      this.deps.log.warn({ day, session, seq }, 'telegram signals: no asset with enough price history; entry skipped');
      return;
    }
    const display = assets.find((a) => a.id === pick.assetId)!.display;
    const ins = await this.deps.pool.query<{ id: string }>(
      `insert into telegram_signals (day, session, seq, asset_id, display, direction, entry_at, expiry_sec, gales)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (day, session, seq) do nothing returning id`,
      [day, session, seq, pick.assetId, display, pick.direction, new Date(entryAt), this.opts.expirySec, this.opts.gales],
    );
    const id = ins.rows[0]?.id;
    if (!id) return;
    const text = signalText({ display, direction: pick.direction, entryAt, expirySec: this.opts.expirySec, gales: this.opts.gales }, this.opts.links);
    const messageId = await this.send('signal', text);
    if (messageId !== null) await this.deps.pool.query('update telegram_signals set message_id = $2 where id = $1', [id, messageId]);
    this.deps.log.info({ day, session, seq, display, direction: pick.direction, strength: pick.strength, confirmed: pick.confirmed }, 'telegram signal posted');
  }

  private async priceAt(assetId: number, t: number): Promise<number | null> {
    const { rows } = await this.deps.pool.query<{ price: string }>(
      `select price::text as price from price_snapshots
        where asset_id = $1 and captured_at <= $2 and captured_at >= $2 - make_interval(secs => $3)
        order by captured_at desc limit 1`,
      [assetId, new Date(t), PRICE_WINDOW_SEC],
    );
    return rows[0] ? Number(rows[0].price) : null;
  }

  private async resolve(now: number): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      asset_id: number;
      display: string;
      direction: Direction;
      entry_at: Date;
      expiry_sec: number;
      gales: number;
      message_id: string | null;
    }>(
      `select id, asset_id, display, direction, entry_at, expiry_sec, gales, message_id
         from telegram_signals where result is null and entry_at <= $1 order by entry_at`,
      [new Date(now)],
    );
    for (const s of rows) {
      const entry = s.entry_at.getTime();
      const stepMs = s.expiry_sec * 1000;
      const steps: Array<StepPrices | null> = [];
      for (let k = 0; k <= s.gales; k++) {
        const end = entry + (k + 1) * stepMs;
        if (now < end + SETTLE_DELAY_MS) break;
        const open = await this.priceAt(s.asset_id, entry + k * stepMs);
        const close = await this.priceAt(s.asset_id, end);
        steps.push(open === null || close === null ? null : { open, close });
      }
      const decided = decideSignal(s.direction, s.gales, steps);
      if (!decided) continue;
      const upd = await this.deps.pool.query(
        `update telegram_signals set result = $2, result_step = $3, resolved_at = now() where id = $1 and result is null`,
        [s.id, decided.result, decided.step],
      );
      if (!upd.rowCount) continue;
      await this.postResult(s.display, decided.result, decided.step, s.message_id ? Number(s.message_id) : null);
      this.deps.log.info({ id: s.id, display: s.display, ...decided }, 'telegram signal resolved');
    }
  }

  /** Win and loss go out as a sticker only (reply to the signal); if the sticker fails, the text. */
  private async postResult(display: string, result: string, step: number | null, replyTo: number | null): Promise<void> {
    const sticker = result === 'win' ? this.opts.resultStickers.win : result === 'loss' ? this.opts.resultStickers.loss : null;
    if (sticker) {
      try {
        await this.deps.telegram.sendSticker(sticker, { replyTo });
        this.sent.inc({ kind: 'result' });
        if (result === 'win') await this.send('green', WIN_CHEER);
        return;
      } catch (err) {
        this.failed.inc({ kind: 'result_sticker' });
        this.deps.log.warn({ err: (err as Error).message, result }, 'telegram sticker failed; sending the text');
      }
    }
    await this.send('result', resultText({ display, result, result_step: step }), replyTo);
  }

  private async sessionRows(day: string, session: string) {
    const { rows } = await this.deps.pool.query<{
      display: string;
      entry_at: Date;
      direction: Direction;
      result: string | null;
      result_step: number | null;
    }>('select display, entry_at, direction, result, result_step from telegram_signals where day = $1 and session = $2 order by seq', [day, session]);
    return rows;
  }

  private async stopLoss(day: string, session: string, name: string): Promise<void> {
    if (this.opts.stopLoss <= 0) return;
    const rows = await this.sessionRows(day, session);
    const losses = rows.filter((r) => r.result === 'loss').length;
    if (losses < this.opts.stopLoss) return;
    const claim = await this.deps.pool.query(
      `insert into telegram_signal_sessions (day, session, stopped_at, reported_at) values ($1, $2, now(), now())
       on conflict (day, session) do update set stopped_at = now(), reported_at = coalesce(telegram_signal_sessions.reported_at, now())
       where telegram_signal_sessions.stopped_at is null
       returning 1`,
      [day, session],
    );
    if (!claim.rowCount) return;
    const done = rows.filter((r): r is (typeof rows)[number] & { result: string } => r.result !== null);
    await this.send('stop_loss', stopLossText(name, day, done, losses, this.opts.links));
    this.deps.log.info({ day, session, losses }, 'telegram signals: stop loss reached');
  }

  private async report(day: string, session: string, name: string): Promise<void> {
    const rows = await this.sessionRows(day, session);
    if (rows.length === 0 || rows.some((r) => r.result === null)) return;
    const claim = await this.deps.pool.query(
      `insert into telegram_signal_sessions (day, session, reported_at) values ($1, $2, now())
       on conflict (day, session) do update set reported_at = now() where telegram_signal_sessions.reported_at is null
       returning 1`,
      [day, session],
    );
    if (!claim.rowCount) return;
    await this.send('report', reportText(name, day, rows as Array<(typeof rows)[number] & { result: string }>, this.opts.links));
  }
}

export const SIGNAL_DEFAULTS = {
  ...SCHEDULE_DEFAULTS,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  expirySec: 60,
  gales: 2,
  stopLoss: 2,
  tickMs: 5_000,
  weeklyPosts: WEEKLY_POSTS,
  resultStickers: {
    // "VITÓRIA WIN" and "MERCADO TURBULENTO", file_ids as received by @kydeninvestbot (only valid for this bot).
    win: 'CAACAgEAAxkBAAMGawUyzkfwvqXKtnHAKvBPROn6eegAAhUCAALDIzFH2mt5yl0JHtI9BA',
    loss: 'CAACAgEAAxkBAAMEawUyaWHYBhuYvyturA5xq0dWpZAAAsYAA1sOOUeMHxZsWVH4eD0E',
  },
} as const;
