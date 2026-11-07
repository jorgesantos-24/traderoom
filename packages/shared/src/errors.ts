export const ErrorCode = {
  BadRequest: 'bad_request',
  ValidationFailed: 'validation_failed',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  PayloadTooLarge: 'payload_too_large',
  RateLimited: 'rate_limited',
  Internal: 'internal_error',
  InvalidCredentials: 'invalid_credentials',
  AccountBlocked: 'account_blocked',
  EmailTaken: 'email_taken',
  InvalidToken: 'invalid_token',
  CsrfFailed: 'csrf_failed',
  Unavailable: 'service_unavailable',
  UnknownAsset: 'unknown_asset',
  InsufficientBalance: 'insufficient_balance',
  AssetStale: 'asset_stale',
  IdempotencyConflict: 'idempotency_conflict',
  KycRequired: 'kyc_required',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Every API error response has exactly this shape. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
