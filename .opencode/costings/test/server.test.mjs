import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { SCHEMA_VERSION, dbPath } from '../schema.mjs';
import { FIXTURE, SERVER, makeProject, openDb, request, startServer, writeFixture } from './_helpers.mjs';

async function serve(t, { fixture = true } = {}) {
  const project = makeProject();
  if (fixture) await writeFixture(project.root);
  const srv = await startServer({ root: project.root });
  t.after(async () => {
    await srv.stop();
    project.cleanup();
  });
  return { ...srv, root: project.root };
}

test('GET /api/usage returns the changes and Other for the project', async (t) => {
  const srv = await serve(t);
  const res = await request(srv.port, { path: '/api/usage' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.root, srv.root);
  assert.equal(res.json.recorded, true);
  assert.deepEqual(res.json.changes.map((c) => [c.name, c.totals.total]), [
    ['fix-login-redirect', FIXTURE.fixLoginRedirect.total],
    ['cancel-orders', FIXTURE.cancelOrders.total],
  ]);
  assert.deepEqual(res.json.other.map((o) => o.label), ['/setup']);
  assert.equal(res.json.agentColors.debugger, '#DC2626');
});

test('CSV downloads follow the filter', async (t) => {
  const srv = await serve(t);
  const all = await request(srv.port, { path: '/usage-by-agent.csv' });
  assert.equal(all.status, 200);
  assert.equal(all.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(all.headers['content-disposition'], 'attachment; filename="usage-by-agent.csv"');
  assert.ok(all.text.startsWith('\uFEFFchange,type,status,'));
  const bugs = await request(srv.port, { path: '/usage-replies.csv?filter=bug' });
  assert.equal(bugs.headers['content-disposition'], 'attachment; filename="usage-replies-bug.csv"');
  assert.equal(bugs.text.trim().split('\r\n').length, 3);
  assert.equal((await request(srv.port, { path: '/usage-by-agent.csv?filter=nope' })).status, 400);
});

test('requests from other sites and wrong methods are refused', async (t) => {
  const srv = await serve(t, { fixture: false });
  assert.equal((await request(srv.port, { path: '/api/usage', headers: { Host: `evil.example:${srv.port}` } })).status, 403);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/shutdown', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/usage', body: {} })).status, 405);
  assert.equal((await request(srv.port, { path: '/nope' })).status, 404);
  const health = await request(srv.port, { path: '/api/health' });
  assert.deepEqual([health.json.app, health.json.root], ['opencode-costings', srv.root]);
});

test('a project with nothing recorded gets the empty state and header-only CSVs', async (t) => {
  const srv = await serve(t, { fixture: false });
  const usage = await request(srv.port, { path: '/api/usage' });
  assert.equal(usage.status, 200);
  assert.deepEqual([usage.json.recorded, usage.json.changes, usage.json.other], [false, [], []]);
  const csv = await request(srv.port, { path: '/usage-replies.csv' });
  assert.equal(csv.text, '\uFEFFcompleted,change,type,agent,model,session,parent_session,input,output,reasoning,cache_read,cache_write,total,cost_usd\r\n');
});

test('a database from a newer template gets a clear message', async (t) => {
  const srv = await serve(t, { fixture: false });
  const db = await openDb(srv.root);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  const res = await request(srv.port, { path: '/api/usage' });
  assert.equal(res.status, 409);
  assert.equal(res.json.reason, 'newer-schema');
  assert.match(res.json.error, /newer version of the template/);
});

test('an unreadable database is named in the error', async (t) => {
  const srv = await serve(t, { fixture: false });
  writeFileSync(dbPath(srv.root), 'this is not a database, only text long enough to fill the header of a page');
  const res = await request(srv.port, { path: '/api/usage' });
  assert.equal(res.status, 500);
  assert.match(res.json.error, /usage\.db/);
});

test('the page reads while opencode is writing', async (t) => {
  const srv = await serve(t);
  const db = await openDb(srv.root);
  let open = true;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO reply (id, session_id, change_name, command, agent, model, completed_at, input, output, reasoning, cache_read, cache_write, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('r9', 'ses_bug', 'fix-login-redirect', 'bug', 'developer', 'anthropic/claude-sonnet-5-5', Date.UTC(2026, 9, 4), 1, 1, 0, 0, 0, 0);
    const during = await request(srv.port, { path: '/api/usage' });
    assert.equal(during.status, 200);
    assert.equal(during.json.changes[0].totals.total, FIXTURE.fixLoginRedirect.total);
    db.exec('COMMIT');
    open = false;
    const after = await request(srv.port, { path: '/api/usage' });
    assert.equal(after.json.changes[0].totals.total, FIXTURE.fixLoginRedirect.total + 2);
  } finally {
    if (open) db.exec('ROLLBACK');
    db.close();
  }
});

test('--csv writes the export to stdout, with nothing on stderr', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  await writeFixture(project.root);
  const ok = spawnSync(process.execPath, [SERVER, '--root', project.root, '--csv', 'summary', '--filter', 'feature'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, '');
  assert.ok(ok.stdout.startsWith('\uFEFFchange,type,status,finished,agent,model,'));
  assert.match(ok.stdout, /\r\ncancel-orders,feature,finished,/);
  assert.doesNotMatch(ok.stdout, /fix-login-redirect/);
  const bad = spawnSync(process.execPath, [SERVER, '--root', project.root, '--csv', 'everything'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--csv must be summary or replies/);
});

test('GET / serves the page with a strict content security policy and nothing from the internet', async (t) => {
  const srv = await serve(t, { fixture: false });
  const page = await request(srv.port, { path: '/' });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.text, /<title>Token usage<\/title>/);
  assert.doesNotMatch(page.text, /https?:\/\//);
});
