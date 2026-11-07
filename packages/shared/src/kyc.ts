import { z } from 'zod';
import { PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from './orders.js';
import { isValidCpf, onlyDigits } from './payments.js';

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';
export const KYC_DOC_TYPES = ['RG', 'CNH', 'RNE', 'PASSAPORTE'] as const;
export type KycDocType = (typeof KYC_DOC_TYPES)[number];
export const KYC_FILE_KINDS = ['doc_front', 'doc_back', 'selfie'] as const;
export type KycFileKind = (typeof KYC_FILE_KINDS)[number];
export const KYC_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Per image, after the client shrinks it. */
export const KYC_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const KYC_MIN_AGE = 18;

export const BR_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

/** Files a document type needs (a passport has no back). */
export const requiredKycFiles = (doc: KycDocType): KycFileKind[] =>
  doc === 'PASSAPORTE' ? ['doc_front', 'selfie'] : ['doc_front', 'doc_back', 'selfie'];

/** Age in whole years on `today` for an ISO date (YYYY-MM-DD). */
export function ageOn(birthIso: string, today: Date): number {
  const [y, m, d] = birthIso.split('-').map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--;
  return age;
}

const text = (label: string, max: number) =>
  z.string(`Informe ${label}.`).trim().min(1, `Informe ${label}.`).max(max, `${label[0]?.toUpperCase()}${label.slice(1)} muito longo.`);

export const KycSubmitInput = z.object({
  fullName: text('o nome completo', 120).refine((v) => v.split(/\s+/).length >= 2, 'Informe nome e sobrenome.'),
  cpf: z
    .string('Informe o CPF.')
    .refine(isValidCpf, 'CPF inválido.')
    .transform(onlyDigits),
  birthDate: z
    .string('Informe a data de nascimento.')
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de nascimento inválida.')
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Data de nascimento inválida.'),
  phone: z
    .string('Informe o celular.')
    .transform(onlyDigits)
    .refine((v) => /^\d{10,11}$/.test(v), 'Celular inválido: use DDD + número.'),
  zip: z
    .string('Informe o CEP.')
    .transform(onlyDigits)
    .refine((v) => v.length === 8, 'CEP inválido.'),
  street: text('a rua', 120),
  number: text('o número', 20),
  complement: z.string().trim().max(60, 'Complemento muito longo.').optional(),
  district: text('o bairro', 80),
  city: text('a cidade', 80),
  state: z.enum(BR_STATES, 'Estado inválido.'),
  docType: z.enum(KYC_DOC_TYPES, 'Tipo de documento inválido.'),
});
export type KycSubmitInput = z.infer<typeof KycSubmitInput>;
export type KycSubmitRequest = z.input<typeof KycSubmitInput>;

export const KycFileParams = z.object({ kind: z.enum(KYC_FILE_KINDS, 'Arquivo inválido.') });
export const KycAdminFileParams = z.object({ id: z.uuid('Identificador inválido.'), kind: z.enum(KYC_FILE_KINDS, 'Arquivo inválido.') });

export const AdminKycQuery = z.object({
  status: z.enum(['pending', 'all'], 'Filtro inválido.').default('pending'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX_LIMIT).default(PAGE_DEFAULT_LIMIT),
});
export type AdminKycQuery = z.infer<typeof AdminKycQuery>;

export const AdminKycRejectInput = z.object({
  reason: z.string('Informe o motivo.').trim().min(5, 'Explique o motivo (mínimo 5 caracteres).').max(300, 'Motivo muito longo.'),
});

export interface KycSubmissionView {
  id: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  fullName: string | null;
  cpf: string | null;
  birthDate: string | null;
  phone: string | null;
  zip: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  docType: KycDocType | null;
  /** Which images are already uploaded. */
  files: KycFileKind[];
  rejectReason: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
}

/** GET /api/kyc: the user's status plus the open (or latest) submission. */
export interface KycStateView {
  status: KycStatus;
  submission: KycSubmissionView | null;
}

export interface AdminKycView extends KycSubmissionView {
  userId: string;
  userEmail: string;
  userName: string;
  createdAt: string;
}
