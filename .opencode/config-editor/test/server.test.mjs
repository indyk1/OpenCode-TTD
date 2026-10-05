// Integration tests: the real server process against a temp copy of the project, with a fake `opencode` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { childEnv, makeFakeOpencode, makeProject, request, startServer, waitForExit } from './_helpers.mjs';

const agentsDir = (root) => path.join(root, '.opencode', 'agents');
const snapshot = (root) => Object.fromEntries(readdirSync(agentsDir(root)).map((f) => [f, readFileSync(path.join(agentsDir(root), f), 'utf8')]));
const calls = (log) => {
  try {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

test('server endpoints with opencode on PATH', async (t) => {
  const project = makeProject();
  const fake = makeFakeOpencode(project.root);
  const srv = await startServer({ root: project.root, env: childEnv({ pathDirs: [fake.bin] }) });
  t.after(async () => {
    await srv.stop();
    project.cleanup();
  });
  const { port } = srv;
  const original = snapshot(project.root);

  await t.test('GET / serves the page without caching', async () => {
    const res = await request(port, { path: '/' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.text, /<h1>Agent models<\/h1>/);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  await t.test('GET /api/health identifies the editor and its root', async () => {
    const res = await request(port, { path: '/api/health', headers: { Host: `localhost:${port}` } });
    assert.equal(res.status, 200);
    assert.equal(res.json.app, 'opencode-config-editor');
    assert.equal(res.json.root, project.root);
  });

  await t.test('GET /api/agents lists every agent with its frontmatter fields', async () => {
    const res = await request(port, { path: '/api/agents' });
    assert.equal(res.status, 200);
    assert.equal(res.json.root, project.root);
    assert.deepEqual(res.json.global, { model: null, small_model: null, default_agent: 'senior-dev' });
    assert.equal(res.json.agents.length, 6);
    const reviewer = res.json.agents.find((a) => a.name === 'test-reviewer');
    assert.deepEqual(
      { ...reviewer, description: undefined },
      { name: 'test-reviewer', file: '.opencode/agents/test-reviewer.md', description: undefined, mode: 'subagent', hidden: true, color: '#0891B2', model: 'anthropic/claude-opus-5-5', variant: 'high' },
    );
  });

  await t.test('GET /api/models runs `opencode models` once and caches it', async () => {
    const first = await request(port, { path: '/api/models' });
    assert.equal(first.status, 200);
    assert.equal(first.json.source, 'opencode');
    assert.deepEqual(first.json.providers, {
      anthropic: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-4-5'],
      openai: ['openai/gpt-5.1'],
    });
    assert.ok(!Number.isNaN(Date.parse(first.json.fetchedAt)));
    const second = await request(port, { path: '/api/models' });
    assert.deepEqual(second.json, first.json);
    assert.deepEqual(calls(fake.log), ['models']);
  });

  await t.test('GET /api/models?refresh=1 runs `opencode models --refresh`', async () => {
    const res = await request(port, { path: '/api/models?refresh=1' });
    assert.equal(res.json.source, 'opencode');
    assert.deepEqual(res.json.providers.anthropic, ['anthropic/claude-opus-5-5', 'anthropic/claude-opus-6', 'anthropic/claude-sonnet-5-5']);
    assert.deepEqual(res.json.providers.openai, ['openai/gpt-5.2']);
    assert.deepEqual(calls(fake.log), ['models', 'models --refresh']);
    const cached = await request(port, { path: '/api/models' });
    assert.deepEqual(cached.json.providers.openai, ['openai/gpt-5.2']);
    assert.equal(calls(fake.log).length, 2);
  });

  await t.test('a bad Host header is refused (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `0.0.0.0:${port}`]) {
      const res = await request(port, { path: '/api/agents', headers: { Host: host } });
      assert.equal(res.status, 403, host);
    }
    const post = await request(port, { method: 'POST', path: '/api/agents', headers: { Host: 'evil.example' }, body: { changes: [{ name: 'developer', variant: 'max' }] } });
    assert.equal(post.status, 403);
    assert.deepEqual(snapshot(project.root), original);
  });

  await t.test('a foreign Origin is refused on POST (CSRF)', async () => {
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
      const res = await request(port, { method: 'POST', path: '/api/agents', headers: { Origin: origin }, body: { changes: [{ name: 'developer', variant: 'max' }] } });
      assert.equal(res.status, 403, origin);
    }
    const shutdown = await request(port, { method: 'POST', path: '/api/shutdown', headers: { Origin: 'http://evil.example' }, body: {} });
    assert.equal(shutdown.status, 403);
    assert.deepEqual(snapshot(project.root), original);
  });

  await t.test('POST needs application/json and a body under 64KB', async () => {
    const text = await request(port, { method: 'POST', path: '/api/agents', headers: { 'Content-Type': 'text/plain' }, body: '{"changes":[]}' });
    assert.equal(text.status, 415);
    const form = await request(port, { method: 'POST', path: '/api/shutdown', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    assert.equal(form.status, 415);
    const big = await request(port, { method: 'POST', path: '/api/agents', body: JSON.stringify({ changes: [], pad: 'x'.repeat(70 * 1024) }) });
    assert.equal(big.status, 413);
    const broken = await request(port, { method: 'POST', path: '/api/agents', body: '{"changes": [' });
    assert.equal(broken.status, 400);
    const options = await request(port, { method: 'OPTIONS', path: '/api/agents', headers: { Origin: 'http://evil.example' } });
    assert.equal(options.status, 405);
    assert.equal(options.headers['access-control-allow-origin'], undefined);
    assert.deepEqual(snapshot(project.root), original);
  });

  await t.test('an invalid batch writes nothing', async () => {
    for (const changes of [
      [{ name: 'developer', variant: 'max' }, { name: 'test-writer', model: 'bad model' }],
      [{ name: 'developer', variant: 'max' }, { name: '../../opencode', variant: 'low' }],
      [{ name: 'developer', variant: 'ultra' }],
    ]) {
      const res = await request(port, { method: 'POST', path: '/api/agents', headers: { Origin: `http://127.0.0.1:${port}` }, body: { changes } });
      assert.equal(res.status, 400, JSON.stringify(changes));
      assert.ok(Array.isArray(res.json.errors) && res.json.errors.length > 0);
    }
    assert.deepEqual(snapshot(project.root), original);
  });

  await t.test('a valid batch saves every change and returns the updated agents', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/api/agents',
      headers: { Origin: `http://localhost:${port}` },
      body: {
        changes: [
          { name: 'test-reviewer', model: 'openai/gpt-5.1', variant: 'max' },
          { name: 'developer', variant: '' },
          { name: 'senior-dev', model: 'anthropic/claude-opus-6' },
        ],
      },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.saved, ['test-reviewer', 'developer', 'senior-dev']);
    const byName = Object.fromEntries(res.json.agents.map((a) => [a.name, a]));
    assert.equal(byName['test-reviewer'].model, 'openai/gpt-5.1');
    assert.equal(byName['test-reviewer'].variant, 'max');
    assert.equal(byName.developer.variant, null);
    assert.equal(byName['senior-dev'].model, 'anthropic/claude-opus-6');
    assert.equal(byName['senior-dev'].variant, 'high');

    const now = snapshot(project.root);
    assert.equal(now['test-reviewer.md'], original['test-reviewer.md'].replace('model: anthropic/claude-opus-5-5', 'model: openai/gpt-5.1').replace('variant: high', 'variant: max'));
    assert.equal(now['developer.md'], original['developer.md'].replace('variant: medium\n', ''));
    assert.equal(now['senior-dev.md'], original['senior-dev.md'].replace('model: anthropic/claude-opus-5-5', 'model: anthropic/claude-opus-6'));
    for (const f of ['debugger.md', 'platform.md', 'test-writer.md']) assert.equal(now[f], original[f], f);
    assert.deepEqual(Object.keys(now).sort(), Object.keys(original).sort(), 'no temp files left behind');

    const again = await request(port, { path: '/api/agents' });
    assert.equal(again.json.agents.find((a) => a.name === 'test-reviewer').model, 'openai/gpt-5.1');
  });

  await t.test('unknown routes and methods', async () => {
    assert.equal((await request(port, { path: '/nope' })).status, 404);
    assert.equal((await request(port, { path: '/../../etc/passwd' })).status, 404);
    assert.equal((await request(port, { method: 'DELETE', path: '/api/agents' })).status, 405);
    assert.equal((await request(port, { path: '/api/shutdown' })).status, 405);
  });

  await t.test('POST /api/shutdown stops the server', async () => {
    const res = await request(port, { method: 'POST', path: '/api/shutdown', headers: { Origin: `http://127.0.0.1:${port}` }, body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(await waitForExit(srv.child), 0);
    await assert.rejects(request(port, { path: '/api/health' }), /ECONNREFUSED/);
  });
});

test('model list falls back to source "none" when opencode is missing', async (t) => {
  const project = makeProject();
  const srv = await startServer({ root: project.root, env: childEnv() });
  t.after(async () => {
    await srv.stop();
    project.cleanup();
  });
  const res = await request(srv.port, { path: '/api/models' });
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'none');
  assert.deepEqual(res.json.providers, {});
  assert.match(res.json.error, /opencode was not found on PATH/);
  // Saving still works with a hand-typed model.
  const save = await request(srv.port, { method: 'POST', path: '/api/agents', body: { changes: [{ name: 'debugger', model: 'custom-provider/my-model' }] } });
  assert.equal(save.status, 200);
  assert.match(readFileSync(path.join(agentsDir(project.root), 'debugger.md'), 'utf8'), /\nmodel: custom-provider\/my-model\n/);
});

test('model list reports a failing opencode', async (t) => {
  const project = makeProject();
  const fake = makeFakeOpencode(project.root, { fail: true });
  const srv = await startServer({ root: project.root, env: childEnv({ pathDirs: [fake.bin] }) });
  t.after(async () => {
    await srv.stop();
    project.cleanup();
  });
  const res = await request(srv.port, { path: '/api/models' });
  assert.equal(res.json.source, 'none');
  assert.match(res.json.error, /failed: boom: provider config is broken/);
});

test('model list falls back to the Anthropic API when ANTHROPIC_API_KEY is set', async (t) => {
  const seen = [];
  const mock = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-haiku-4-5', type: 'model' }], has_more: false }));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const project = makeProject();
  const srv = await startServer({
    root: project.root,
    env: childEnv({ extra: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}` } }),
  });
  t.after(async () => {
    await srv.stop();
    mock.close();
    project.cleanup();
  });
  const res = await request(srv.port, { path: '/api/models' });
  assert.equal(res.json.source, 'anthropic-api');
  assert.deepEqual(res.json.providers, { anthropic: ['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5'] });
  assert.deepEqual(seen, [{ url: '/v1/models?limit=1000', key: 'sk-test', version: '2023-06-01' }]);
});

test('idle timeout stops the server', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  // --idle-minutes takes whole minutes; check the timer wiring with the smallest value through the module instead.
  const { createEditorServer } = await import('../server.mjs');
  let stopped = false;
  const editor = createEditorServer({ root: project.root, idleMinutes: 0.002, onShutdown: () => (stopped = true) });
  await editor.listen(0);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(stopped, true);
});
