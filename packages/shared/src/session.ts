/** Name of the httpOnly session cookie, read by both the API and the WS gateway. */
export const SESSION_COOKIE = 'sid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Session cookie value is `<sessionId>.<token>`. The id gives a primary-key lookup;
 * the token is then checked against the stored SHA-256 in constant time.
 */
export function encodeSessionCookie(sessionId: string, token: string): string {
  return `${sessionId}.${token}`;
}

export function parseSessionCookie(value: string | undefined): { sessionId: string; token: string } | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const sessionId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!UUID_RE.test(sessionId) || !TOKEN_RE.test(token)) return null;
  return { sessionId, token };
}
