// Browser test with Playwright. Skipped unless the `playwright` package can be found
// (for example: NODE_PATH=$(npm root -g) node --test .opencode/diagrams/test/).
// The page loads Mermaid from jsDelivr; the test never goes online. With the pinned version's mermaid.min.js
// available - DIAGRAMS_MERMAID_JS=<path>, or the `mermaid` package on NODE_PATH - it is served in jsDelivr's place
// (the page's integrity check still applies) and the drawn diagrams are checked. Otherwise only the offline
// fallback is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DIAGRAMS_DIR, makeProject, makeShop, startServer } from './_helpers.mjs';

const require = createRequire(import.meta.url); // honours NODE_PATH
let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  try {
    playwright = require('playwright');
  } catch {}
}
const skip = playwright ? false : 'playwright is not installed';
const launchOptions = () => (process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});

const PINNED = /cdn\.jsdelivr\.net\/npm\/mermaid@([\d.]+)\//.exec(readFileSync(path.join(DIAGRAMS_DIR, 'index.html'), 'utf8'))[1];

/** The pinned version's mermaid.min.js, if it is on this computer. */
function localMermaid() {
  let file = process.env.DIAGRAMS_MERMAID_JS;
  if (!file) {
    try {
      file = require.resolve('mermaid/dist/mermaid.min.js');
    } catch {
      return null;
    }
  }
  if (!existsSync(file)) return null;
  const pkg = path.join(path.dirname(file), '..', 'package.json');
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).version !== PINNED) return null;
  return readFileSync(file);
}
const MERMAID = localMermaid();

async function newPage(browser, { mermaid = MERMAID, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme, acceptDownloads: true });
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    mermaid
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body: mermaid, headers: { 'Access-Control-Allow-Origin': '*' } })
      : route.abort(),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return { page, errors };
}

test('the diagram pages', { skip }, async (t) => {
  const project = makeShop();
  const empty = makeProject();
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
  const drawn = MERMAID ? '#diagram svg' : '#fallback';

  await t.test('the architecture page draws the application', async () => {
    const { page, errors } = await newPage(browser);
    await page.goto(srv.url);
    await page.locator(drawn).waitFor();
    assert.equal(await page.title(), 'Architecture diagram');
    assert.equal(await page.locator('#tab-architecture').getAttribute('aria-current'), 'page');
    assert.match(await page.locator('#cards').innerText(), /Slices\s+3/);
    if (MERMAID) {
      assert.match(await page.locator('#diagram svg').textContent(), /CancelOrder.*POST \/orders\/\{orderId:guid\}\/cancel/);
      assert.match(await page.locator('#zoom-level').textContent(), /^\d+%$/);
    }
    assert.equal(await page.locator('#download-mmd').getAttribute('href'), '/architecture.mmd');
    assert.deepEqual(errors, []);
  });

  await t.test('the classes page follows the chosen part of the code in its address', async () => {
    const { page, errors } = await newPage(browser);
    await page.goto(`${srv.url}/classes`);
    await page.locator(drawn).waitFor();
    assert.equal(await page.title(), 'Classes diagram');
    assert.equal(await page.locator('#scope').inputValue(), 'project:Shop');
    await page.locator('#scope').selectOption('slice:Shop/Orders/CancelOrder');
    await page.waitForURL(/scope=slice%3AShop%2FOrders%2FCancelOrder$/);
    await page.locator('#cards').getByText('4', { exact: true }).waitFor();
    assert.match(await page.locator('#cards').innerText(), /Types shown\s+4\s+Related types\s+5/);
    if (MERMAID) {
      await page.locator('#diagram svg .related').first().waitFor();
      assert.equal(await page.locator('#diagram svg .related').count(), 5);
    }
    await page.locator('#members').uncheck();
    await page.waitForURL(/members=0/);
    assert.equal(await page.locator('#download-mmd').getAttribute('href'), '/classes.mmd?scope=slice%3AShop%2FOrders%2FCancelOrder&members=0');
    await page.reload();
    await page.locator(drawn).waitFor();
    assert.equal(await page.locator('#scope').inputValue(), 'slice:Shop/Orders/CancelOrder');
    assert.equal(await page.locator('#members').isChecked(), false);
    assert.deepEqual(errors, []);
  });

  await t.test('the drawn diagram downloads as SVG', { skip: MERMAID ? false : `mermaid ${PINNED} is not available locally` }, async () => {
    const { page } = await newPage(browser);
    await page.goto(`${srv.url}/classes?scope=domain%3AShop`);
    await page.locator('#diagram svg').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-svg').click()]);
    assert.equal(download.suggestedFilename(), 'classes-domain-Shop.svg');
    const svg = readFileSync(await download.path(), 'utf8');
    assert.match(svg, /^<svg[^>]* width="\d+"/);
    assert.match(svg, /^<svg[^>]* height="\d+"/);
    assert.match(svg, /Money/);
  });

  await t.test('without Mermaid the page shows the diagram as Mermaid text', async () => {
    const { page, errors } = await newPage(browser, { mermaid: null });
    await page.goto(srv.url);
    await page.locator('#fallback').waitFor();
    assert.match(await page.locator('#fallback-text').textContent(), /could not be loaded/);
    assert.match(await page.locator('#source').textContent(), /^flowchart LR\n/);
    assert.equal(await page.locator('#download-svg').isDisabled(), true);
    assert.deepEqual(errors, []);
  });

  await t.test('says so when there is no code yet', async () => {
    const { page } = await newPage(browser);
    await page.goto(`${emptySrv.url}/classes`);
    await page.locator('#empty').waitFor();
    assert.match(await page.locator('#empty').textContent(), /There is no C# code here yet/);
    assert.equal(await page.locator('#stage').isHidden(), true);
  });
});
