import { describe, expect, it } from 'vitest';
import { readCookie } from '../src/gateway/session.js';

describe('readCookie', () => {
  it('finds a cookie among others and decodes it', () => {
    expect(readCookie('a=1; sid=abc%2Edef; __Host-csrf=x', 'sid')).toBe('abc.def');
    expect(readCookie('sid=first', 'sid')).toBe('first');
  });

  it('does not match on a name suffix or prefix', () => {
    expect(readCookie('xsid=1; sidx=2', 'sid')).toBeUndefined();
  });

  it('returns undefined for missing headers and bad encoding', () => {
    expect(readCookie(undefined, 'sid')).toBeUndefined();
    expect(readCookie('', 'sid')).toBeUndefined();
    expect(readCookie('sid=%E0%A4%A', 'sid')).toBeUndefined();
  });
});
