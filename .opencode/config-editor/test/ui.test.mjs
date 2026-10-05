// Browser test with Playwright. Skipped unless the `playwright` package can be found
// (for example: NODE_PATH=$(npm root -g) node --test .opencode/config-editor/test/).
// Set CONFIG_EDITOR_SHOTS=<dir> to also save light/dark screenshots at 1280px and 420px.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { childEnv, differingLines, makeFakeOpencode, makeProject, startServer, waitForExit } from './_helpers.mjs';

let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  try {
    playwright = createRequire(import.meta.url)('playwright'); // honours NODE_PATH
  } catch {}
}
const skip = playwright ? false : 'playwright is not installed';
const SHOTS = process.env.CONFIG_EDITOR_SHOTS;

const launchOptions = () => (process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const card = (page, name) => page.locator('article.card').filter({ has: page.locator('h3.agent-name', { hasText: new RegExp(`^${name}$`) }) });
const modelSelect = (page, name) => card(page, name).getByLabel('Model', { exact: true });
const effortSelect = (page, name) => card(page, name).getByLabel('Effort', { exact: true });

async function setup(t) {
  const project = makeProject();
  const fake = makeFakeOpencode(project.root);
  const srv = await startServer({ root: project.root, env: childEnv({ pathDirs: [fake.bin] }) });
  const browser = await playwright.chromium.launch(launchOptions());
  t.after(async () => {
    await browser.close();
    await srv.stop();
    project.cleanup();
  });
  return { project, fake, srv, browser };
}

async function openEditor(browser, url, { colorScheme = 'light', width = 1280 } = {}) {
  const context = await browser.newContext({ colorScheme, viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  await page.goto(url);
  await page.locator('#source-badge[data-state="opencode"]').waitFor();
  return { page, context, errors };
}

test('editing models and effort in the browser', { skip }, async (t) => {
  const { project, fake, srv, browser } = await setup(t);
  const dir = path.join(project.root, '.opencode', 'agents');
  const original = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));
  const { page, errors } = await openEditor(browser, srv.url);

  await t.test('shows the project, the model source and every agent in order', async () => {
    assert.equal(await page.locator('#root').textContent(), project.root);
    assert.equal(await page.locator('#source-text').textContent(), 'Models from: opencode');
    assert.deepEqual(await page.locator('#list-primary h3.agent-name').allTextContents(), ['senior-dev', 'platform']);
    assert.deepEqual(await page.locator('#list-sub h3.agent-name').allTextContents(), ['debugger', 'developer', 'test-reviewer', 'test-writer']);
    assert.equal(await card(page, 'platform').locator('.pill.mode').textContent(), 'Primary + subagent');
    assert.match(await card(page, 'senior-dev').locator('.desc').textContent(), /^Senior Developer and lead of the vertical-slice, test-first workflow\.$/);
    assert.equal(await modelSelect(page, 'senior-dev').inputValue(), 'anthropic/claude-opus-5-5');
    assert.equal(await effortSelect(page, 'developer').inputValue(), 'medium');
    assert.equal(await page.locator('#dirty-count').textContent(), 'No unsaved changes');
    assert.ok(await page.locator('#save-btn').isDisabled());
    assert.match(await page.locator('#globals').textContent(), /default agent senior-dev/);
  });

  await t.test('the provider filter defaults to the providers in use', async () => {
    assert.match(await page.locator('#provider-filter option:checked').textContent(), /^In use \(anthropic\)$/);
    const groups = () => modelSelect(page, 'developer').locator('optgroup').evaluateAll((els) => els.map((e) => e.label));
    assert.deepEqual(await groups(), ['anthropic']);
    await page.locator('#provider-filter').selectOption('__all__');
    assert.deepEqual(await groups(), ['anthropic', 'openai']);
    await page.locator('#provider-filter').selectOption('__used__');
  });

  await t.test('warns while test-reviewer and test-writer share a model', async () => {
    const warnings = page.locator('.row-warning:visible');
    assert.equal(await warnings.count(), 0);
    await modelSelect(page, 'test-reviewer').selectOption('anthropic/claude-sonnet-5-5');
    assert.equal(await warnings.count(), 2);
    assert.match(await card(page, 'test-writer').locator('.row-warning').textContent(), /test-reviewer uses the same model/);
    assert.ok(await page.locator('#save-btn').isEnabled(), 'the warning does not block saving');
    await modelSelect(page, 'test-reviewer').selectOption('anthropic/claude-haiku-4-5');
    assert.equal(await warnings.count(), 0);
  });

  await t.test('marks changed rows and counts them', async () => {
    await modelSelect(page, 'developer').selectOption('anthropic/claude-opus-5-5');
    await effortSelect(page, 'developer').selectOption('xhigh');
    assert.ok(await card(page, 'developer').locator('.pill.modified').isVisible());
    assert.match(await card(page, 'developer').locator('.hint.was').first().textContent(), /Was anthropic\/claude-sonnet-5-5/);
    assert.ok(await card(page, 'test-reviewer').locator('.pill.modified').isVisible());
    assert.ok(!(await card(page, 'senior-dev').locator('.pill.modified').isVisible()));
    assert.equal(await page.locator('#dirty-count').textContent(), '2 unsaved changes');
  });

  await t.test('Custom… takes a typed model and validates it', async () => {
    const select = modelSelect(page, 'debugger');
    const input = card(page, 'debugger').locator('input.custom-input');
    await select.selectOption('__custom__');
    assert.ok(await input.isVisible());
    await input.fill('not a model');
    assert.ok(await card(page, 'debugger').locator('.hint.error').isVisible());
    assert.ok(await page.locator('#save-btn').isDisabled());
    await input.fill('openai/gpt-5.1-codex');
    assert.match(await card(page, 'debugger').locator('.hint.warn').textContent(), /Not in provider list/);
    assert.ok(await page.locator('#save-btn').isEnabled());
    assert.equal(await page.locator('#dirty-count').textContent(), '3 unsaved changes');
    await select.selectOption('anthropic/claude-opus-5-5');
    assert.ok(!(await input.isVisible()));
    assert.equal(await page.locator('#dirty-count').textContent(), '2 unsaved changes');
  });

  await t.test('saving writes exactly the changed lines and shows the restart banner', async () => {
    await page.locator('#save-btn').click();
    const banner = page.locator('.notice.ok');
    await banner.waitFor();
    assert.equal(
      (await banner.locator('p').textContent()).replace(/\s+/g, ' ').replace(/ Updated.*$/, ''),
      'Saved to .opencode/agents/. opencode reads agents at startup — quit opencode and run opencode --continue to resume your session with the new settings.',
    );
    assert.equal(await page.locator('#dirty-count').textContent(), 'No unsaved changes');
    assert.equal(await page.locator('.pill.modified:visible').count(), 0);

    const dev = readFileSync(path.join(dir, 'developer.md'), 'utf8');
    assert.equal(dev, original['developer.md'].replace('model: anthropic/claude-sonnet-5-5', 'model: anthropic/claude-opus-5-5').replace('variant: medium', 'variant: xhigh'));
    assert.equal(differingLines(original['developer.md'], dev).length, 2);
    const reviewer = readFileSync(path.join(dir, 'test-reviewer.md'), 'utf8');
    assert.equal(reviewer, original['test-reviewer.md'].replace('model: anthropic/claude-opus-5-5', 'model: anthropic/claude-haiku-4-5'));
    for (const f of ['debugger.md', 'platform.md', 'senior-dev.md', 'test-writer.md']) {
      assert.equal(readFileSync(path.join(dir, f), 'utf8'), original[f], f);
    }
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, 'editor-light-1280-saved.png') });
    }
  });

  await t.test('effort can be unset', async () => {
    await effortSelect(page, 'senior-dev').selectOption('');
    await page.locator('#save-btn').click();
    await page.locator('#dirty-count', { hasText: 'No unsaved changes' }).waitFor();
    assert.equal(readFileSync(path.join(dir, 'senior-dev.md'), 'utf8'), original['senior-dev.md'].replace('variant: high\n', ''));
  });

  await t.test('Refresh model list reloads from `opencode models --refresh`', async () => {
    await page.locator('#refresh-btn').click();
    await page.locator('#source-badge[data-state="opencode"]').waitFor();
    await modelSelect(page, 'senior-dev').locator('option[value="anthropic/claude-opus-6"]').waitFor({ state: 'attached' });
    assert.match(readFileSync(fake.log, 'utf8'), /models --refresh/);
  });

  await t.test('Revert restores the saved values', async () => {
    await modelSelect(page, 'platform').selectOption('anthropic/claude-opus-6');
    assert.equal(await page.locator('#dirty-count').textContent(), '1 unsaved change');
    await page.locator('#revert-btn').click();
    assert.equal(await modelSelect(page, 'platform').inputValue(), 'anthropic/claude-sonnet-5-5');
    assert.equal(await page.locator('#dirty-count').textContent(), 'No unsaved changes');
  });

  await t.test('leaving with unsaved changes asks first', async () => {
    await effortSelect(page, 'platform').selectOption('max');
    const dialog = new Promise((resolve) => page.once('dialog', async (d) => {
      resolve(d.type());
      await d.dismiss();
    }));
    await page.close({ runBeforeUnload: true });
    assert.equal(await dialog, 'beforeunload');
  });

  await t.test('Stop editor shuts the server down', async () => {
    const { page: second } = await openEditor(browser, srv.url);
    await second.locator('#stop-btn').click();
    await second.getByRole('heading', { name: 'The editor has stopped' }).waitFor();
    assert.equal(await waitForExit(srv.child), 0);
  });

  assert.deepEqual(errors, []);
});

test('a model that is not in the list is flagged, and "none" still allows editing', { skip }, async (t) => {
  const project = makeProject();
  // No opencode on PATH: the list is unavailable.
  const srv = await startServer({ root: project.root, env: childEnv() });
  const browser = await playwright.chromium.launch(launchOptions());
  t.after(async () => {
    await browser.close();
    await srv.stop();
    project.cleanup();
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(srv.url);
  await page.locator('#source-badge[data-state="none"]').waitFor();
  assert.equal(await page.locator('#source-text').textContent(), 'Models from: not available');
  assert.match(await page.locator('.notice.warn').textContent(), /opencode was not found on PATH/);
  assert.ok(await page.locator('#provider-filter').isDisabled());
  // Without a list nothing is flagged as missing from it.
  assert.equal(await page.locator('.hint.warn:visible').count(), 0);
  await modelSelect(page, 'developer').selectOption('__custom__');
  await card(page, 'developer').locator('input.custom-input').fill('openai/gpt-5.1');
  await page.locator('#save-btn').click();
  await page.locator('.notice.ok').waitFor();
  assert.match(readFileSync(path.join(project.root, '.opencode', 'agents', 'developer.md'), 'utf8'), /\nmodel: openai\/gpt-5\.1\n/);
});

test('screenshots in light and dark at 1280px and 420px', { skip: skip || (!SHOTS && 'CONFIG_EDITOR_SHOTS is not set') }, async (t) => {
  const { srv, browser } = await setup(t);
  mkdirSync(SHOTS, { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    for (const width of [1280, 420]) {
      const { page, context } = await openEditor(browser, srv.url, { colorScheme, width });
      // A representative state: two unsaved edits and the test-writer/test-reviewer warning.
      await modelSelect(page, 'developer').selectOption('anthropic/claude-opus-5-5');
      await effortSelect(page, 'developer').selectOption('xhigh');
      await modelSelect(page, 'test-reviewer').selectOption('anthropic/claude-sonnet-5-5');
      // Size the viewport to the page so the sticky save bar is drawn at the bottom, where a user sees it.
      await page.setViewportSize({ width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
      await page.screenshot({ path: path.join(SHOTS, `editor-${colorScheme}-${width}.png`) });
      await context.close();
    }
  }
});
