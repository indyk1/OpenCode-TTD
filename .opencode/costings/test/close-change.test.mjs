import test from 'node:test';
import assert from 'node:assert/strict';
import { closeChange, main } from '../close-change.mjs';
import { makeProject, openDb, plain } from './_helpers.mjs';

function insertReply(db, id, change, total) {
  db.prepare(
    `INSERT INTO reply (id, session_id, change_name, command, agent, model, completed_at, input, output, reasoning, cache_read, cache_write, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 's1', change, 'bug', 'debugger', 'anthropic/claude-opus-5-5', 1, total, 0, 0, 0, 0, 0);
}

test('closeChange records the change as finished, replaces an earlier record, and returns its totals', async (t) => {
  const project = makeProject();
  const db = await openDb(project.root);
  t.after(() => {
    db.close();
    project.cleanup();
  });
  insertReply(db, 'r1', 'fix-login-redirect', 111);
  insertReply(db, 'r2', 'fix-login-redirect', 228);
  insertReply(db, 'r3', 'cancel-orders', 5);
  const summary = 'Fix the "login" redirect, for $HOME users';
  assert.deepEqual(closeChange(db, { name: 'fix-login-redirect', type: 'bug', summary, finishedAt: Date.UTC(2026, 9, 6, 12) }), {
    replies: 2,
    total: 339,
  });
  assert.deepEqual(plain(db.prepare('SELECT * FROM finished_change').all()), [
    { name: 'fix-login-redirect', type: 'bug', finished_at: Date.UTC(2026, 9, 6, 12), summary },
  ]);
  closeChange(db, { name: 'fix-login-redirect', type: 'feature', summary: 'Now a feature', finishedAt: 1 });
  assert.deepEqual(plain(db.prepare('SELECT type, summary FROM finished_change').all()), [{ type: 'feature', summary: 'Now a feature' }]);
});

test('closeChange refuses a bad change name or type', async (t) => {
  const project = makeProject();
  const db = await openDb(project.root);
  t.after(() => {
    db.close();
    project.cleanup();
  });
  assert.throws(() => closeChange(db, { name: 'Cancel Orders', type: 'feature', summary: 'x' }), /not a change name/);
  assert.throws(() => closeChange(db, { name: 'archive', type: 'feature', summary: 'x' }), /not a change name/);
  assert.throws(() => closeChange(db, { name: 'cancel-orders', type: 'chore', summary: 'x' }), /type must be feature or bug/);
});

test('main creates the database when nothing was recorded and prints one line', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const lines = [];
  await main(['cancel-orders', 'feature', 'Customers can cancel orders'], { root: project.root, log: (line) => lines.push(line) });
  assert.deepEqual(lines, ['Token usage for cancel-orders: 0 tokens over 0 model replies.']);
  const db = await openDb(project.root);
  const row = { ...db.prepare('SELECT name, type, summary FROM finished_change').get() };
  db.close();
  assert.deepEqual(row, { name: 'cancel-orders', type: 'feature', summary: 'Customers can cancel orders' });
});
