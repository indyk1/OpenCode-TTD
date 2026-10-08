import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SERVER, makeProject, makeShop, request, startServer, writeFiles } from './_helpers.mjs';

async function serve(t, project = makeShop()) {
  const srv = await startServer({ root: project.root });
  t.after(async () => {
    await srv.stop();
    project.cleanup();
  });
  return { ...srv, root: project.root };
}

test('GET /api/architecture returns the Mermaid text and a summary', async (t) => {
  const srv = await serve(t);
  const res = await request(srv.port, { path: '/api/architecture' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.root, srv.root);
  assert.equal(res.json.empty, false);
  assert.match(res.json.mermaid, /^flowchart LR\n/);
  assert.match(res.json.mermaid, /slice_Shop_Orders_CancelOrder\["CancelOrder<br\/>POST/);
  assert.equal(res.json.summary.slices, 3);
  assert.deepEqual(res.json.warnings, []);
});

test('GET /api/classes draws the chosen scope, the first one by default', async (t) => {
  const srv = await serve(t);
  const first = await request(srv.port, { path: '/api/classes' });
  assert.equal(first.status, 200);
  assert.equal(first.json.scope, 'project:Shop');
  assert.equal(first.json.scopes.length, 12);
  assert.equal(first.json.types, 23);
  const slice = await request(srv.port, { path: '/api/classes?scope=slice%3AShop%2FOrders%2FCancelOrder&members=0&related=0' });
  assert.deepEqual([slice.json.scope, slice.json.types, slice.json.relatedTypes, slice.json.members, slice.json.related], ['slice:Shop/Orders/CancelOrder', 4, 0, false, false]);
  assert.doesNotMatch(slice.json.mermaid, /Route\$/);
  const gone = await request(srv.port, { path: '/api/classes?scope=slice%3AShop%2FOrders%2FGone' });
  assert.deepEqual([gone.status, gone.json.scope, gone.json.requested], [200, 'project:Shop', 'slice:Shop/Orders/Gone']);
});

test('the diagrams change as soon as the code does', async (t) => {
  const srv = await serve(t);
  writeFiles(srv.root, {
    'src/Shop/Features/Orders/ShipOrder/ShipOrder.Contracts.cs': 'namespace Shop.Features.Orders.ShipOrder;\npublic static class ShipOrderContracts { public const string Route = "/orders/{id}/ship"; }\n',
  });
  const res = await request(srv.port, { path: '/api/architecture' });
  assert.match(res.json.mermaid, /ShipOrder<br\/>\? \/orders\/\{id\}\/ship<br\/>no tests yet/);
});

test('.mmd downloads carry the same Mermaid text', async (t) => {
  const srv = await serve(t);
  const api = await request(srv.port, { path: '/api/classes?scope=domain%3AShop' });
  const mmd = await request(srv.port, { path: '/classes.mmd?scope=domain%3AShop' });
  assert.equal(mmd.status, 200);
  assert.equal(mmd.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(mmd.headers['content-disposition'], 'attachment; filename="classes-domain-Shop.mmd"');
  assert.equal(mmd.text, api.json.mermaid);
  const arch = await request(srv.port, { path: '/architecture.mmd' });
  assert.equal(arch.headers['content-disposition'], 'attachment; filename="architecture.mmd"');
  assert.match(arch.text, /^flowchart LR\n/);
});

test('a project with no code yet gets the empty state', async (t) => {
  const srv = await serve(t, makeProject());
  const arch = await request(srv.port, { path: '/api/architecture' });
  assert.deepEqual([arch.status, arch.json.empty, arch.json.summary.projects], [200, true, 0]);
  const classes = await request(srv.port, { path: '/api/classes' });
  assert.deepEqual([classes.status, classes.json.empty, classes.json.scope, classes.json.scopes], [200, true, null, []]);
});

test('requests from other sites and wrong methods are refused', async (t) => {
  const srv = await serve(t, makeProject());
  assert.equal((await request(srv.port, { path: '/api/architecture', headers: { Host: `evil.example:${srv.port}` } })).status, 403);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/shutdown', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/classes', body: {} })).status, 405);
  assert.equal((await request(srv.port, { path: '/nope' })).status, 404);
  const health = await request(srv.port, { path: '/api/health' });
  assert.deepEqual([health.json.app, health.json.root], ['opencode-diagrams', srv.root]);
});

test('both pages are served with a strict content security policy; the only outside script is the pinned Mermaid', async (t) => {
  const srv = await serve(t, makeProject());
  for (const path of ['/', '/classes']) {
    const page = await request(srv.port, { path });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net;/);
    assert.match(csp, /connect-src 'self'/);
    const urls = [...page.text.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(urls)], ['https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js']);
    assert.match(page.text, /integrity: 'sha384-[A-Za-z0-9+/]{64}'/);
  }
});

test('--mermaid writes a diagram to stdout, with nothing on stderr', async (t) => {
  const project = makeShop();
  t.after(() => project.cleanup());
  const run = (...args) => spawnSync(process.execPath, [SERVER, '--root', project.root, ...args], { encoding: 'utf8' });
  const arch = run('--mermaid', 'architecture');
  assert.equal(arch.status, 0, arch.stderr);
  assert.equal(arch.stderr, '');
  assert.match(arch.stdout, /^flowchart LR\n/);
  const slice = run('--mermaid', 'classes', '--scope', 'slice:Shop/Orders/PlaceOrder');
  assert.equal(slice.status, 0, slice.stderr);
  assert.match(slice.stdout, /^classDiagram\n  namespace Shop\.Features\.Orders\.PlaceOrder \{/);
  const missing = run('--mermaid', 'classes', '--scope', 'slice:Nope');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /There is no scope slice:Nope\. Scopes: project:Shop, area:Shop\/Catalog/);
  const bad = run('--mermaid', 'everything');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--mermaid must be architecture or classes/);
});
