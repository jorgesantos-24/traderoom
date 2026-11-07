import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound keeps argon2 work per request bounded. */
export const PASSWORD_MAX_LENGTH = 128;

/** Send the token from `GET /api/auth/csrf` (or the login response) in this header on every POST/PATCH. */
export const CSRF_HEADER = 'x-csrf-token';

const email = z
  .string()
  .trim()
  .max(254, 'E-mail muito longo.')
  .pipe(z.email('E-mail inválido.'));

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);

/** Opaque 32-byte token encoded as base64url (43 chars). */
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Token inválido.');

export const RegisterInput = z.object({
  email,
  password,
  name: z.string().trim().min(1, 'Informe seu nome.').max(80, 'Nome muito longo.'),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email,
  // Login does not enforce the minimum, so old/short passwords give a normal "invalid credentials".
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const ForgotInput = z.object({ email });
export type ForgotInput = z.infer<typeof ForgotInput>;

export const ResetInput = z.object({ token: TokenSchema, password });
export type ResetInput = z.infer<typeof ResetInput>;

export type UserRole = 'user' | 'admin';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
