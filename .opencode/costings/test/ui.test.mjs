// Browser test with Playwright. Skipped unless the `playwright` package can be found
// (for example: NODE_PATH=$(npm root -g) node --test .opencode/costings/test/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeProject, startServer, writeFixture } from './_helpers.mjs';

let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  try {
    playwright = createRequire(import.meta.url)('playwright'); // honours NODE_PATH
  } catch {}
}
const skip = playwright ? false : 'playwright is not installed';
const launchOptions = () => (process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});

test('the token usage page', { skip }, async (t) => {
  const project = makeProject();
  const empty = makeProject();
  await writeFixture(project.root);
  const srv = await startServer({ root: project.root });
  const emptySrv = await startServer({ root: empty.root });
  const browser = await playwright.chromium.launch(launchOptions());
  t.after(async () => {
    await browser.close();
    await srv.stop();
    await emptySrv.stop();
    project.cleanup();
    empty.cleanup();
  });
  const page = await browser.newPage();
  await page.goto(srv.url);
  const names = () => page.locator('.row .name').allTextContents();

  await t.test('lists changes and Other, newest activity first, and opens the first', async () => {
    await page.locator('.row').first().waitFor();
    assert.deepEqual(await names(), ['fix-login-redirect', 'cancel-orders', '/setup']);
    assert.equal(await page.locator('#detail h2').textContent(), 'fix-login-redirect');
  });

  await t.test('shows the per-agent breakdown of the clicked change', async () => {
    await page.locator('.row', { hasText: 'cancel-orders' }).click();
    assert.equal(await page.locator('#detail h2').textContent(), 'cancel-orders');
    const rows = await page.locator('#detail tbody tr').allInnerTexts();
    assert.equal(rows.length, 3);
    assert.match(rows[1], /^test-writer\s+anthropic\/claude-sonnet-5-5\s+2\s+100\s+10\s+0\s+1,000\s+20\s+1,130$/);
  });

  await t.test('filters to bugs and points the CSV links at the filter', async () => {
    await page.getByRole('button', { name: 'Bugs' }).click();
    assert.deepEqual(await names(), ['fix-login-redirect']);
    assert.equal(await page.locator('#csv-summary').getAttribute('href'), '/usage-by-agent.csv?filter=bug');
    assert.equal(await page.locator('#csv-replies').getAttribute('href'), '/usage-replies.csv?filter=bug');
  });

  await t.test('says so when nothing has been recorded', async () => {
    await page.goto(emptySrv.url);
    await page.locator('#empty').waitFor();
    assert.match(await page.locator('#empty').textContent(), /No token usage recorded yet/);
  });
});
