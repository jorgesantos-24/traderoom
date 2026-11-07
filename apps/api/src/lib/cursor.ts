import { z } from 'zod';
import { ErrorCode } from '@traderoom/shared';
import { AppError } from './errors.js';

/**
 * Keyset cursor: (timestamp as Postgres text, row id). Using the database's own text form
 * keeps microsecond precision, so rows that share a millisecond are never skipped.
 */
export interface Cursor {
  at: string;
  id: string;
}

const CursorSchema = z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)]);

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.at, c.id])).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw === '') return null;
  try {
    const [at, id] = CursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (Number.isNaN(Date.parse(at))) throw new Error('bad timestamp');
    return { at, id };
  } catch {
    throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
  }
}
