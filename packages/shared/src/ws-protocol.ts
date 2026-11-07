import { z } from 'zod';
import { SymbolSchema } from './market.js';

export const WS_PATH = '/ws';
/** Must cover every enabled asset: the asset picker subscribes to all of them at once. */
export const WS_MAX_ASSETS_PER_CONNECTION = 64;
export const WS_MAX_CONNECTIONS_PER_USER = 3;
/** Server pings every 20 s and drops a connection silent for 40 s. */
export const WS_HEARTBEAT_MS = 20_000;
export const WS_DEAD_AFTER_MS = 40_000;
/** Largest client message accepted, in bytes. */
export const WS_MAX_MESSAGE_BYTES = 4096;

/** Close codes sent by the gateway (4000–4999 are application-defined). */
export const WsCloseCode = {
  /** No valid session cookie, session expired/revoked or user blocked. */
  Unauthorized: 4401,
  /** Already WS_MAX_CONNECTIONS_PER_USER open connections. */
  TooManyConnections: 4409,
  /** Client sent messages faster than allowed. */
  RateLimited: 4429,
  /** Server shutting down; reconnect with backoff. */
  GoingAway: 1001,
} as const;

// ---- Client → server ----

const assets = z
  .array(SymbolSchema)
  .min(1)
  .max(WS_MAX_ASSETS_PER_CONNECTION, `No máximo ${WS_MAX_ASSETS_PER_CONNECTION} ativos por conexão.`);

export const ClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('sub'), assets }),
  z.object({ t: z.literal('unsub'), assets }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- Server → client ----

/** One conflated price inside a `snapshot` or `tick` frame. */
export interface PriceItem {
  s: string;
  p: number;
  /** Price time, epoch ms. */
  ts: number;
}

/**
 * `seq` comes from one counter shared by the whole gateway process, so a single
 * pre-serialized tick frame can go to every subscriber and still be strictly
 * increasing on each connection (it is monotonic, not contiguous).
 * Clients drop any snapshot/tick whose seq is not above the last one seen.
 */
export interface SnapshotFrame {
  t: 'snapshot';
  seq: number;
  data: PriceItem[];
}

export interface TickFrame {
  t: 'tick';
  seq: number;
  data: PriceItem[];
}

export interface StaleFrame {
  t: 'stale';
  s: string;
  on: boolean;
}

export interface PongFrame {
  t: 'pong';
}

export const WsErrorCode = {
  BadMessage: 'bad_message',
  UnknownAsset: 'unknown_asset',
  TooManyAssets: 'too_many_assets',
} as const;
export type WsErrorCode = (typeof WsErrorCode)[keyof typeof WsErrorCode];

/** Sent when a client message is rejected; the connection stays open. */
export interface ErrorFrame {
  t: 'error';
  code: WsErrorCode;
  message: string;
  /** Symbols the error refers to, when relevant. */
  assets?: string[];
}

export type ServerFrame = SnapshotFrame | TickFrame | StaleFrame | PongFrame | ErrorFrame;
