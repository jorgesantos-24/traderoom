import { describe, expect, it } from 'vitest';
import {
  encodeSessionCookie,
  generateToken,
  parseSessionCookie,
  safeEqual,
  sha256Hex,
} from '../src/lib/tokens.js';

describe('tokens', () => {
  it('generates 32-byte base64url tokens that do not repeat', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('sha256Hex matches a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safeEqual compares content, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('session cookie round-trips', () => {
    const id = '5f0c8a1e-3b7d-4c2a-9e61-0d4b8f2a7c13';
    const token = generateToken();
    expect(parseSessionCookie(encodeSessionCookie(id, token))).toEqual({ sessionId: id, token });
  });

  it.each([
    undefined,
    '',
    'no-dot',
    `not-a-uuid.${'a'.repeat(43)}`,
    `5f0c8a1e-3b7d-4c2a-9e61-0d4b8f2a7c13.short`,
    `5f0c8a1e-3b7d-4c2a-9e61-0d4b8f2a7c13.${'a'.repeat(44)}`,
    `5f0c8a1e-3b7d-4c2a-9e61-0d4b8f2a7c13.${'a'.repeat(42)}=`,
    `5F0C8A1E-3B7D-4C2A-9E61-0D4B8F2A7C13.${'a'.repeat(43)}`,
  ])('rejects malformed session cookie %s', (value) => {
    expect(parseSessionCookie(value)).toBeNull();
  });
});
