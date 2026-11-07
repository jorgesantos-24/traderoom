import type { FastifyInstance } from 'fastify';
import {
  AdminKycQuery,
  AdminKycRejectInput,
  ErrorCode,
  KYC_MAX_FILE_BYTES,
  KYC_MIME_TYPES,
  KycAdminFileParams,
  KycFileParams,
  KycSubmitInput,
  PaymentIdParams,
} from '@traderoom/shared';
import { AppError } from '../lib/errors.js';
import { authOf } from '../plugins/security.js';
import type { KycService } from '../services/kyc.js';

export function kycRoutes(app: FastifyInstance, deps: { kyc: KycService }): void {
  const noStore = 'no-store';
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/kyc', auth, async (req, reply) => {
    return reply.header('cache-control', noStore).send(await deps.kyc.state(authOf(req).user.id));
  });

  app.post('/api/kyc/submit', auth, async (req, reply) => {
    const input = KycSubmitInput.parse(req.body);
    const state = await deps.kyc.submit(authOf(req).user.id, input);
    req.log.info({ userId: authOf(req).user.id }, 'kyc submitted');
    return reply.header('cache-control', noStore).send(state);
  });

  // Photos are sent one per request as the raw image body.
  void app.register(async (files) => {
    for (const mime of KYC_MIME_TYPES) {
      files.addContentTypeParser(mime, { parseAs: 'buffer', bodyLimit: KYC_MAX_FILE_BYTES + 1024 }, (_req, body, done) => done(null, body));
    }
    files.put('/api/kyc/files/:kind', { ...auth, bodyLimit: KYC_MAX_FILE_BYTES + 1024 }, async (req, reply) => {
      const { kind } = KycFileParams.parse(req.params);
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, ErrorCode.BadRequest, 'Envie a imagem (JPG, PNG ou WEBP).');
      const state = await deps.kyc.uploadFile(authOf(req).user.id, kind, req.body);
      return reply.header('cache-control', noStore).send(state);
    });
  });

  app.get('/api/admin/kyc', admin, async (req, reply) => {
    const q = AdminKycQuery.parse(req.query);
    return reply.header('cache-control', noStore).send(await deps.kyc.adminList(q));
  });

  app.get('/api/admin/kyc/:id', admin, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    return reply.header('cache-control', noStore).send({ submission: await deps.kyc.adminGet(id) });
  });

  app.get('/api/admin/kyc/:id/files/:kind', admin, async (req, reply) => {
    const { id, kind } = KycAdminFileParams.parse(req.params);
    const file = await deps.kyc.adminFile(id, kind);
    return reply
      .header('cache-control', 'private, no-store')
      .header('content-type', file.mime)
      .header('content-disposition', 'inline')
      .send(file.data);
  });

  app.post('/api/admin/kyc/:id/approve', admin, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    const submission = await deps.kyc.approve(authOf(req).user.id, id);
    req.log.info({ submissionId: id }, 'kyc approved');
    return reply.header('cache-control', noStore).send({ submission });
  });

  app.post('/api/admin/kyc/:id/reject', admin, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    const { reason } = AdminKycRejectInput.parse(req.body);
    const submission = await deps.kyc.reject(authOf(req).user.id, id, reason);
    req.log.info({ submissionId: id }, 'kyc rejected');
    return reply.header('cache-control', noStore).send({ submission });
  });
}
