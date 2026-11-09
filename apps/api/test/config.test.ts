import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
  PUBLIC_ORIGIN: 'https://app.example.com/',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('loadConfig', () => {
  it('applies defaults and trims the origin', () => {
    const c = loadConfig({ ...BASE });
    expect(c.PUBLIC_ORIGIN).toBe('https://app.example.com');
    expect(c.RESEND_API_KEY).toBeUndefined();
    expect(c.MAIL_FROM).toContain('Traderoom');
  });

  it('treats an empty RESEND_API_KEY (as in .env.example) as unset', () => {
    expect(loadConfig({ ...BASE, RESEND_API_KEY: '' }).RESEND_API_KEY).toBeUndefined();
    expect(loadConfig({ ...BASE, RESEND_API_KEY: ' re_123 ' }).RESEND_API_KEY).toBe('re_123');
  });

  it('instant withdrawals: 7% when unset, off when empty', () => {
    expect(loadConfig({ ...BASE }).WITHDRAW_INSTANT_FEE_PCT).toBe(7);
    expect(loadConfig({ ...BASE, WITHDRAW_INSTANT_FEE_PCT: '' }).WITHDRAW_INSTANT_FEE_PCT).toBeUndefined();
    expect(loadConfig({ ...BASE, WITHDRAW_INSTANT_FEE_PCT: '5.5' }).WITHDRAW_INSTANT_FEE_PCT).toBe(5.5);
    expect(() => loadConfig({ ...BASE, WITHDRAW_INSTANT_FEE_PCT: 'x' })).toThrow(/WITHDRAW_INSTANT_FEE_PCT/);
    expect(loadConfig({ ...BASE }).WITHDRAW_FEE_PCT).toBe(2);
  });

  it('names every invalid variable', () => {
    expect(() => loadConfig({ ...BASE, DATABASE_URL: 'nope', API_PORT: '70000' })).toThrow(/DATABASE_URL.*API_PORT|API_PORT.*DATABASE_URL/);
  });
});
