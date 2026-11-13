import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { resetAuthRateLimits } from './rate-limits';

const ENV_FILE = new URL('../../../.env', import.meta.url);
if (!process.env.DATABASE_URL && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const CREDIT_CENTS = 10_000;
const STAKE_CENTS = 1_000;
const PASSWORD = 'e2e-senha-forte-123';
const email = `e2e-${Date.now()}@traderoom.test`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

/** Same thing an admin credit does in milestone 7: balance + ledger row, under the account lock. */
async function credit(userEmail: string, cents: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ user_id: string; balance_cents: string }>(
      `select a.user_id, a.balance_cents from accounts a join users u on u.id = a.user_id where u.email = $1 and a.kind = 'real' for update`,
      [userEmail],
    );
    const acc = rows[0];
    if (!acc) throw new Error(`no account for ${userEmail}`);
    const after = Number(acc.balance_cents) + cents;
    await client.query(`update accounts set balance_cents = $2 where user_id = $1 and kind = 'real'`, [acc.user_id, after]);
    await client.query(
      `insert into ledger (user_id, delta_cents, balance_after, kind, note) values ($1, $2, $3, 'credit', 'Crédito de teste E2E')`,
      [acc.user_id, cents, after],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function cleanup(userEmail: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>('select id from users where email = $1', [userEmail]);
  const id = rows[0]?.id;
  if (!id) return;
  await pool.query('delete from ledger where user_id = $1', [id]);
  await pool.query('delete from orders where user_id = $1', [id]);
  await pool.query('delete from users where id = $1', [id]);
}

const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }).replace(/ /g, ' ');

async function balanceText(page: Page): Promise<string> {
  return ((await page.getByTestId('balance').textContent()) ?? '').replace(/ /g, ' ');
}

test.beforeAll(resetAuthRateLimits);

test.afterAll(async () => {
  await cleanup(email);
  await pool.end();
});

test('register → login → order → settlement → updated balance', async ({ page }) => {
  test.setTimeout(240_000);
  // Register.
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Criar conta' })).toBeVisible();
  await page.getByLabel('Nome').fill('Teste E2E');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Criar conta' }).click();

  // Login.
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await expect(page.getByText('Conta criada. Entre para continuar.')).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/traderoom$/);

  // A new user starts on the demo account with US$ 10.000; switch to the real one, which is empty.
  await expect(page.getByTestId('account-kind')).toHaveText('Demo');
  await expect.poll(() => balanceText(page)).toBe(brl(1_000_000));
  await page.getByTestId('account-switcher').click();
  await page.getByTestId('account-real').click();
  await expect(page.getByTestId('account-kind')).toHaveText('Real');
  await expect.poll(() => balanceText(page)).toBe(brl(0));

  // A new account has no money: ordering is blocked.
  await page.getByRole('button', { name: 'Abrir outro gráfico' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^BTC\/USD/ })
    .click();
  await expect(page.getByRole('tab', { name: /BTC\/USD/, selected: true })).toBeVisible();
  await expect(page.getByTestId('block-reason')).toHaveText('Saldo insuficiente para este valor.', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Acima/ })).toBeDisabled();

  // Credit, then reload: the balance comes from the API.
  await credit(email, CREDIT_CENTS);
  await page.reload();
  await expect.poll(() => balanceText(page)).toBe(brl(CREDIT_CENTS));

  // Place a 1-minute US$ 10 call once the live price is in.
  await page.getByLabel('Invest').fill('10');
  // Expiry options are 1, 5, 15 and 30 minutes; the first one is picked.
  await expect(page.locator('output').first()).toHaveText('1 minuto');
  await expect(page.getByTestId('block-reason')).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole('button', { name: /Acima/ }).click();

  // Open positions sit under the "Portfólio total" bar.
  await page.getByRole('button', { name: 'Exibir posições' }).click();
  const openOrder = page.getByTestId('open-order');
  await expect(openOrder).toHaveCount(1);
  await expect(page.getByTestId('order-announcer')).toContainText('aberta em BTC/USDT');
  await expect.poll(() => balanceText(page)).toBe(brl(CREDIT_CENTS - STAKE_CENTS));
  await expect(openOrder).toContainText(/Ganhando|Perdendo|Empatando/);

  // Settlement: the order closes at the end of its 1-minute candle, or of the next one on a late entry
  // (last 50 s of the candle), so up to 110 s; then worker grace and the screen polls the result.
  await expect(page.getByTestId('order-announcer')).toContainText(/ganhou|perdeu|anulada/, { timeout: 130_000 });
  await expect(openOrder).toHaveCount(0);
  const { rows } = await pool.query<{ payout_pct: number; status: string }>(
    `select o.payout_pct, o.status from orders o join users u on u.id = o.user_id where u.email = $1`,
    [email],
  );
  expect(rows).toHaveLength(1);
  const settled = rows[0] as { payout_pct: number; status: string };
  const said = { won: 'ganhou', lost: 'perdeu', void: 'anulada' }[settled.status];
  expect(said, `unexpected status ${settled.status}`).toBeDefined();
  await expect(page.getByTestId('order-announcer')).toContainText(said as string);
  const finalCents =
    settled.status === 'won'
      ? CREDIT_CENTS + Math.floor((STAKE_CENTS * settled.payout_pct) / 100)
      : settled.status === 'lost'
        ? CREDIT_CENTS - STAKE_CENTS
        : CREDIT_CENTS;
  await expect.poll(() => balanceText(page)).toBe(brl(finalCents));

  // Wallet and history agree.
  await page.getByRole('button', { name: 'Mais' }).click();
  await page.getByRole('link', { name: 'Carteira' }).click();
  await expect.poll(async () => ((await page.getByTestId('wallet-balance').textContent()) ?? '').replace(/ /g, ' ')).toBe(brl(finalCents));
  // credit + stake, plus payout or refund unless the order lost.
  await expect(page.getByTestId('ledger-row')).toHaveCount(settled.status === 'lost' ? 2 : 3);
  await page.getByRole('button', { name: 'Histórico' }).click();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await expect(page.getByTestId('history-row')).toContainText(/US\$|Devolvido/);
  await page.getByTestId('history-row').getByRole('button').click();
  await expect(page.getByText('Informações da operação')).toBeVisible();
});
