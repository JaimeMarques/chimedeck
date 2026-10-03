import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer | undefined;
const uiUrl = process.env.TEST_UI_URL ?? 'http://127.0.0.1:5188';

test.use({
  browserName: 'chromium',
  hasTouch: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
    : {}),
});

test.beforeAll(async () => {
  if (!process.env.TEST_UI_URL) {
    server = await createServer({ server: { host: '127.0.0.1', port: 5188, strictPort: true } });
    await server.listen();
  }
});

test.afterAll(async () => { await server?.close(); });

async function openCard(page: Page, cover = false) {
  await page.goto(`${uiUrl}/tests/e2e/fixtures/card-modal.html${cover ? '?cover' : ''}`);
  const surface = page.locator('[data-card-modal-content]');
  await expect(surface).toBeVisible();
  await expect(page.getByText('Last attachment', { exact: true })).toBeAttached();
  return surface;
}

async function assertContained(page: Page) {
  const close = page.getByRole('button', { name: 'Close', exact: true });
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  for (const control of [close, activity]) {
    await expect(control).toBeInViewport();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  const width = await page.locator('[data-card-modal-content]').evaluate((element) => ({
    client: element.clientWidth, scroll: element.scrollWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
}

async function touchScroll(page: Page, body: Locator) {
  const box = await body.boundingBox();
  expect(box).not.toBeNull();
  const session = await page.context().newCDPSession(page);
  const x = box!.x + box!.width / 2;
  const start = box!.y + box!.height * 0.85;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
  for (let step = 1; step <= 8; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x, y: start - box!.height * 0.65 * step / 8 }],
    });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 667, height: 375 }]) {
  test(`mobile card scrolls with activity shown and hidden at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const surface = await openCard(page);
    const body = surface.locator(':scope > .overflow-y-auto');
    await expect(body).toHaveCount(1);
    await assertContained(page);
    await touchScroll(page, body);
    await page.getByText('Last attachment', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('Last attachment', { exact: true })).toBeInViewport();
    await page.getByText('Activity comment 30', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('Activity comment 30', { exact: true })).toBeInViewport();
    await assertContained(page);

    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page.getByText('Activity comment 30', { exact: true })).not.toBeAttached();
    await touchScroll(page, body);
    await page.getByText('Last attachment', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('Last attachment', { exact: true })).toBeInViewport();
    await assertContained(page);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(surface).not.toBeVisible();
  });
}

test('desktop panes scroll independently, including a short landscape viewport', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const surface = await openCard(page);
    const panes = surface.locator(':scope > .overflow-hidden > .overflow-y-auto');
    await expect(panes).toHaveCount(2);
    const left = panes.nth(0);
    const right = panes.nth(1);
    await left.evaluate((element) => { element.scrollTop = 400; });
    expect(await left.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await right.evaluate((element) => element.scrollTop)).toBe(0);
    await right.evaluate((element) => { element.scrollTop = 300; });
    expect(await right.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await left.evaluate((element) => element.scrollTop)).toBe(400);
    await assertContained(page);
  }
});

test('mobile full cover keeps the footer and close control available', async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 667, height: 375 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const surface = await openCard(page, true);
    const body = surface.locator(':scope > .flex-1');
    const height = await body.evaluate((element) => element.clientHeight);
    console.log(`Full cover ${viewport.width}x${viewport.height}: body height ${height}`);
    expect(height).toBeGreaterThanOrEqual(80);
    await assertContained(page);
    await page.getByText('Last attachment', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('Last attachment', { exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    expect(await surface.locator(':scope > .flex-1').evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(80);
    await page.getByText('Last attachment', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('Last attachment', { exact: true })).toBeInViewport();
    await assertContained(page);
  }
});
