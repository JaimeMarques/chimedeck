import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { strict as assert } from 'node:assert';

const [state, executablePath] = process.argv.slice(2);
if (!state || !executablePath)
  throw new Error('Explicit private state and browser executable required');
const credentials = JSON.parse(await readFile(resolve(state, 'credentials.json'), 'utf8'));
if (
  credentials.frontendUrl !== 'http://127.0.0.1:35173' ||
  credentials.apiUrl !== 'http://127.0.0.1:33000'
)
  throw new Error('Refusing non-local browser target');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' && ['35173', '33000', '34566'].includes(url.port)
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.goto(`${credentials.frontendUrl}/login`);
  await page.locator('#login-email').fill(credentials.admin.email);
  await page.locator('#login-password').fill(credentials.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/workspaces', { timeout: 15000 });
  await page.goto(`${credentials.frontendUrl}/b/labboard?card=labcard1`);
  await page.getByText('Lab card', { exact: true }).last().waitFor({ timeout: 15000 });
  await page.getByText('Complete UTF-8 description', { exact: false }).waitFor({ timeout: 15000 });
  assert.equal(errors.length, 0, 'Local browser runtime error');
  await page.screenshot({ path: resolve(state, 'browser-smoke.png'), fullPage: true });
  await page.goto(`${credentials.frontendUrl}/developer/mcp`);
  await page.getByRole('heading', { name: 'Compact results and verified writes' }).waitFor();
  await page.getByRole('heading', { name: 'set_checklist_items', exact: true }).waitFor();
  assert.equal(errors.length, 0, 'Developer MCP documentation runtime error');
  await writeFile(
    resolve(state, 'browser-result.json'),
    JSON.stringify({
      status: 'passed',
      login: 'real password form',
      board: 'real private board',
      card: 'full UTF-8 description',
      docs: 'compact results and batch checklist reference',
      pageErrors: errors.length,
    }),
    { mode: 0o600 }
  );
  console.info('PASS browser login, private board and full UTF-8 card description');
} finally {
  await browser.close();
}
