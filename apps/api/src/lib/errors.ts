import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCode, type ApiErrorBody } from '@traderoom/shared';

/** Throw this from any handler to return a typed error response. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function body(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

const fastifyCodeMap: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: ErrorCode.PayloadTooLarge, message: 'Corpo da requisição muito grande.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: ErrorCode.BadRequest, message: 'Content-Type não suportado.' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: ErrorCode.BadRequest, message: 'Corpo JSON vazio.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: ErrorCode.BadRequest, message: 'JSON inválido.' },
};

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof AppError) {
    void reply.status(err.statusCode).send(body(err.code, err.message));
    return;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    void reply.status(400).send(body(ErrorCode.ValidationFailed, `${where}${first?.message ?? 'Entrada inválida.'}`));
    return;
  }
  const fe = err as FastifyError;
  const mapped = fe.code ? fastifyCodeMap[fe.code] : undefined;
  if (mapped) {
    void reply.status(mapped.status).send(body(mapped.code, mapped.message));
    return;
  }
  if (fe.statusCode === 429) {
    void reply.status(429).send(body(ErrorCode.RateLimited, 'Muitas requisições. Tente novamente em instantes.'));
    return;
  }
  if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    void reply.status(fe.statusCode).send(body(ErrorCode.BadRequest, 'Requisição inválida.'));
    return;
  }
  req.log.error({ err }, 'unhandled error');
  void reply.status(500).send(body(ErrorCode.Internal, 'Erro interno.'));
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send(body(ErrorCode.NotFound, 'Recurso não encontrado.'));
}
