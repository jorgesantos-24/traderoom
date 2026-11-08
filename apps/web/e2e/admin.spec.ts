import { existsSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { resetAuthRateLimits } from './rate-limits';

const ENV_FILE = new URL('../../../.env', import.meta.url);
if (!process.env.DATABASE_URL && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PASSWORD = 'e2e-senha-forte-123';
const stamp = Date.now();
const adminEmail = `e2e-admin-${stamp}@traderoom.test`;
const userEmail = `e2e-cliente-${stamp}@traderoom.test`;
const userName = `Cliente ${stamp}`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let asset: { id: number; display: string; payout_pct: number; enabled: boolean };

const nb = (s: string | null) => (s ?? '').replace(/ /g, ' ');

async function register(page: Page, email: string, name: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  // Admin credits go to the real account; new visitors start on demo.
  await ctx.addInitScript(() => localStorage.setItem('traderoom:account', 'real'));
  return ctx.newPage();
}

test.beforeAll(async () => {
  await resetAuthRateLimits();
  const { rows } = await pool.query<typeof asset>('select id, display, payout_pct, enabled from assets where enabled order by sort, id limit 1');
  if (!rows[0]) throw new Error('no enabled asset to edit');
  asset = rows[0];
});

test.afterAll(async () => {
  // Put the edited asset back exactly as it was, then drop everything the test created.
  await pool.query('update assets set payout_pct = $2, enabled = $3 where id = $1', [asset.id, asset.payout_pct, asset.enabled]);
  const users = `select id from users where email in ($1, $2)`;
  await pool.query(`delete from admin_audit where admin_id in (${users})`, [adminEmail, userEmail]);
  await pool.query(`delete from ledger where user_id in (${users})`, [adminEmail, userEmail]);
  await pool.query(`delete from orders where user_id in (${users})`, [adminEmail, userEmail]);
  await pool.query('delete from users where email in ($1, $2)', [adminEmail, userEmail]);
  await pool.end();
});

test('admin credits, blocks and unblocks a user, edits an asset, and every action is audited', async ({ page, browser }) => {
  // Two accounts; the first becomes admin the same way `npm run admin-role -- promote` does it.
  await register(page, adminEmail, 'Admin E2E');
  await register(page, userEmail, userName);
  await pool.query(`update users set role = 'admin' where email = $1`, [adminEmail]);

  // A regular user does not see the Admin link and is turned away from /admin.
  const client = await freshPage(browser);
  await login(client, userEmail);
  await expect(client).toHaveURL(/\/traderoom$/);
  await expect(client.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await client.goto('/admin');
  await expect(client.getByText('Acesso restrito')).toBeVisible();

  await login(page, adminEmail);
  await expect(page).toHaveURL(/\/traderoom$/);
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Administração' })).toBeVisible();

  // Search and credit US$ 50,00.
  await page.getByLabel('Buscar por nome ou e-mail').fill(userEmail);
  const row = page.getByTestId('admin-user-row').filter({ hasText: userEmail });
  await expect(page.getByTestId('admin-user-row')).toHaveCount(1);
  await row.getByRole('button', { name: /Ajustar saldo/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajustar saldo' });
  await dialog.getByLabel('Valor (US$)').fill('50');
  await dialog.getByRole('button', { name: 'Lançar crédito' }).click();
  await expect(dialog.getByText('Descreva o motivo (mínimo 3 caracteres).')).toBeVisible();
  await dialog.getByLabel('Motivo').fill('Bônus E2E');
  await expect(dialog.getByText(/Saldo após o ajuste/)).toContainText('50,00');
  await dialog.getByRole('button', { name: 'Lançar crédito' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => nb(await row.textContent())).toContain('US$ 50,00');
  await expect(page.getByTestId('admin-notice')).toContainText('Crédito de US$');

  // A debit larger than the balance is refused before it is sent.
  await row.getByRole('button', { name: /Ajustar saldo/ }).click();
  await dialog.getByText('Débito').click();
  await dialog.getByLabel('Valor (US$)').fill('60');
  await dialog.getByLabel('Motivo').fill('Teste de limite');
  await dialog.getByRole('button', { name: 'Lançar débito' }).click();
  await expect(dialog.getByText(/O débito máximo é/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();

  // The user sees the credit in the wallet.
  await client.goto('/wallet');
  await expect.poll(async () => nb(await client.getByTestId('wallet-balance').textContent())).toBe('US$ 50,00');
  await expect(client.getByTestId('ledger-row').first()).toContainText('Bônus E2E');

  // Block: the user's session ends and login is refused.
  await row.getByRole('button', { name: /^Bloquear/ }).click();
  await page.getByRole('dialog', { name: 'Bloquear usuário' }).getByRole('button', { name: 'Bloquear' }).click();
  await expect(row).toContainText('Bloqueado');
  await client.reload();
  await expect(client).toHaveURL(/\/login/);
  await login(client, userEmail);
  await expect(client.getByText('Conta bloqueada. Fale com o suporte.')).toBeVisible();

  // Unblock: login works again and the balance is intact.
  await row.getByRole('button', { name: /^Desbloquear/ }).click();
  await page.getByRole('dialog', { name: 'Desbloquear usuário' }).getByRole('button', { name: 'Desbloquear' }).click();
  await expect(row).toContainText('Ativo');
  await login(client, userEmail);
  await expect(client).toHaveURL(/\/traderoom$/);
  await expect.poll(async () => nb(await client.getByTestId('balance').textContent())).toBe('US$ 50,00');

  // Asset editor: invalid payout is blocked, a valid one saves.
  await page.getByRole('tab', { name: 'Ativos' }).click();
  const assetRow = page.getByTestId('admin-asset-row').filter({ hasText: asset.display });
  const input = assetRow.getByLabel(`Payout de ${asset.display} em porcentagem`);
  await input.fill('99');
  await expect(assetRow.getByText('Entre 50 e 95.')).toBeVisible();
  await expect(assetRow.getByRole('button', { name: `Salvar ${asset.display}` })).toBeDisabled();
  const newPct = asset.payout_pct === 90 ? 89 : 90;
  await input.fill(String(newPct));
  await assetRow.getByRole('button', { name: `Salvar ${asset.display}` }).click();
  await expect(page.getByTestId('admin-notice')).toContainText(`payout ${newPct}%`);
  const { rows } = await pool.query<{ payout_pct: number }>('select payout_pct from assets where id = $1', [asset.id]);
  expect(rows[0]?.payout_pct).toBe(newPct);

  // Keyboard: arrow keys move between tabs.
  await page.getByRole('tab', { name: 'Ativos' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Auditoria' })).toHaveAttribute('aria-selected', 'true');

  // Audit trail, newest first.
  const audit = page.getByTestId('audit-row').filter({ hasText: adminEmail });
  await expect(audit).toHaveCount(4);
  await expect(audit.nth(0)).toContainText('Alteração de ativo');
  await expect(audit.nth(0)).toContainText(`payout ${asset.payout_pct}% → ${newPct}%`);
  await expect(audit.nth(1)).toContainText('Desbloqueio de usuário');
  await expect(audit.nth(2)).toContainText('Bloqueio de usuário');
  await expect(audit.nth(3)).toContainText('Crédito de saldo');
  await expect(audit.nth(3)).toContainText('Bônus E2E');
  await page.getByLabel('Ação').selectOption('user.credit');
  await expect(page.getByTestId('audit-row').filter({ hasText: adminEmail })).toHaveCount(1);
});
