import test from 'node:test';
import assert from 'node:assert/strict';
import { changeCreatedBy, changeMentionedIn, createRecorder } from '../recorder.mjs';
import { makeProject, openDb, plain } from './_helpers.mjs';

const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } };

async function setup(t) {
  const project = makeProject();
  const db = await openDb(project.root);
  const warnings = [];
  let clock = Date.UTC(2026, 9, 6, 9, 0);
  const rec = createRecorder({ open: () => db, warn: (m) => warnings.push(m), now: () => clock });
  t.after(() => {
    db.close();
    project.cleanup();
  });
  return {
    rec,
    db,
    warnings,
    tick: (ms = 1000) => (clock += ms),
    replies: () => plain(db.prepare('SELECT id, change_name, command, agent FROM reply ORDER BY completed_at, id').all()),
  };
}

const session = (id, created, parentID) => ({
  event: { type: 'session.created', properties: { info: { id, parentID, time: { created, updated: created } } } },
});
const reply = (id, sessionID, completed, { agent = 'senior-dev', model = 'anthropic/claude-opus-5-5', tokens = TOKENS, cost = 0.01, done = true } = {}) => {
  const [providerID, modelID] = model.split('/');
  return {
    event: {
      type: 'message.updated',
      properties: {
        info: {
          id, sessionID, role: 'assistant', agent, mode: agent, providerID, modelID, cost, tokens,
          time: { created: completed - 500, ...(done ? { completed } : {}) },
        },
      },
    },
  };
};
const command = (sessionID, name, args = '') => ({ command: name, sessionID, arguments: args });
const bash = (sessionID, cmd) => ({ tool: 'bash', sessionID, callID: 'c1', args: { command: cmd, description: 'x' } });
const read = (sessionID, filePath) => ({ tool: 'read', sessionID, callID: 'c1', args: { filePath } });

test('changeCreatedBy and changeMentionedIn find change names, never archive or file contents', () => {
  assert.equal(changeCreatedBy('openspec new change "cancel-orders" --schema vsa-tdd'), 'cancel-orders');
  assert.equal(changeCreatedBy("cd x && openspec new change 'fix-a' --schema vsa-tdd-bugfix"), 'fix-a');
  assert.equal(changeCreatedBy('openspec new change Cancel'), null);
  assert.equal(changeCreatedBy(undefined), null);
  assert.equal(changeMentionedIn({ filePath: 'openspec/changes/cancel-orders/proposal.md' }), 'cancel-orders');
  assert.equal(changeMentionedIn({ path: 'C:\\work\\my project\\openspec\\changes\\fix-a' }), 'fix-a');
  assert.equal(changeMentionedIn({ command: 'openspec instructions design --change "cancel-orders" --json' }), 'cancel-orders');
  assert.equal(changeMentionedIn({ command: 'openspec status --change=cancel-orders' }), 'cancel-orders');
  assert.equal(changeMentionedIn({ filePath: 'openspec/changes/archive/2026-09-29-cancel-orders/status.md' }), null);
  assert.equal(changeMentionedIn({ filePath: 'README.md', content: 'see openspec/changes/cancel-orders/' }), null);
  assert.equal(changeMentionedIn(null), null);
});

test('a /feature run: planning replies are back-filled when the change is named, and subagents inherit it', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_a', r.tick()));
  r.tick();
  r.rec.commandBefore(command('ses_a', 'feature', 'let customers cancel orders'));
  r.rec.event(reply('m1', 'ses_a', r.tick()));
  r.rec.toolAfter(bash('ses_a', 'openspec new change "cancel-orders" --schema vsa-tdd'));
  r.rec.event(reply('m2', 'ses_a', r.tick()));
  r.rec.event(session('ses_tw', r.tick(), 'ses_a'));
  r.rec.event(reply('m3', 'ses_tw', r.tick(), { agent: 'test-writer', model: 'anthropic/claude-sonnet-5-5' }));
  r.rec.event(session('ses_dev', r.tick(), 'ses_a'));
  r.rec.event(reply('m4', 'ses_dev', r.tick(), { agent: 'developer' }));
  assert.deepEqual(r.replies(), [
    { id: 'm1', change_name: 'cancel-orders', command: 'feature', agent: 'senior-dev' },
    { id: 'm2', change_name: 'cancel-orders', command: 'feature', agent: 'senior-dev' },
    { id: 'm3', change_name: 'cancel-orders', command: 'feature', agent: 'test-writer' },
    { id: 'm4', change_name: 'cancel-orders', command: 'feature', agent: 'developer' },
  ]);
  assert.deepEqual(r.warnings, []);
});

test('a reply updated several times is recorded once, with its final counts', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_a', r.tick()));
  const done = r.tick();
  r.rec.event(reply('m1', 'ses_a', done, { done: false, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  r.rec.event(reply('m1', 'ses_a', done));
  r.rec.event(reply('m1', 'ses_a', done, { tokens: { input: 120, output: 30, reasoning: 5, cache: { read: 1000, write: 50 } } }));
  assert.deepEqual(plain(r.db.prepare('SELECT id, input, output, reasoning, cache_read, cache_write FROM reply').all()), [
    { id: 'm1', input: 120, output: 30, reasoning: 5, cache_read: 1000, cache_write: 50 },
  ]);
});

test('/resume names the change straight away, with or without the slash; an empty /resume waits for a mention', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_b', r.tick()));
  r.rec.commandBefore(command('ses_b', 'resume', 'cancel-orders'));
  r.rec.event(reply('m1', 'ses_b', r.tick()));
  r.rec.event(session('ses_c', r.tick()));
  r.rec.commandBefore(command('ses_c', '/resume', '  cancel-orders  please'));
  r.rec.event(reply('m2', 'ses_c', r.tick()));
  r.rec.event(session('ses_d', r.tick()));
  r.rec.commandBefore(command('ses_d', 'resume', ''));
  r.rec.event(reply('m3', 'ses_d', r.tick()));
  r.rec.toolAfter(read('ses_d', 'openspec/changes/order-history/status.md'));
  assert.deepEqual(r.replies(), [
    { id: 'm1', change_name: 'cancel-orders', command: 'resume', agent: 'senior-dev' },
    { id: 'm2', change_name: 'cancel-orders', command: 'resume', agent: 'senior-dev' },
    { id: 'm3', change_name: 'order-history', command: 'resume', agent: 'senior-dev' },
  ]);
});

test('a /bug that stops early keeps the debugger rows under the bug', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_a', r.tick()));
  r.rec.commandBefore(command('ses_a', 'bug', 'the login redirect is broken'));
  r.rec.event(reply('m1', 'ses_a', r.tick()));
  r.rec.toolAfter(bash('ses_a', 'openspec new change "fix-login-redirect" --schema vsa-tdd-bugfix'));
  r.rec.event(session('ses_dbg', r.tick(), 'ses_a'));
  r.rec.event(reply('m2', 'ses_dbg', r.tick(), { agent: 'debugger' }));
  r.rec.event(reply('m3', 'ses_a', r.tick()));
  assert.deepEqual(r.replies(), [
    { id: 'm1', change_name: 'fix-login-redirect', command: 'bug', agent: 'senior-dev' },
    { id: 'm2', change_name: 'fix-login-redirect', command: 'bug', agent: 'debugger' },
    { id: 'm3', change_name: 'fix-login-redirect', command: 'bug', agent: 'senior-dev' },
  ]);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM finished_change').get().n, 0);
});

test('a second /feature in the same session starts fresh, and earlier rows keep their change', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_a', r.tick()));
  r.rec.commandBefore(command('ses_a', 'feature', 'cancel orders'));
  r.rec.toolAfter(bash('ses_a', 'openspec new change "cancel-orders" --schema vsa-tdd'));
  r.rec.event(reply('m1', 'ses_a', r.tick()));
  r.tick();
  r.rec.commandBefore(command('ses_a', 'feature', 'show order history'));
  r.rec.event(reply('m2', 'ses_a', r.tick()));
  r.rec.toolAfter(bash('ses_a', 'openspec new change "order-history" --schema vsa-tdd'));
  r.rec.event(reply('m3', 'ses_a', r.tick()));
  // Naming another change without a command switches from now on, and re-assigns nothing.
  r.rec.toolAfter(bash('ses_a', 'openspec new change "refunds" --schema vsa-tdd'));
  r.rec.event(reply('m4', 'ses_a', r.tick()));
  assert.deepEqual(r.replies().map((x) => [x.id, x.change_name]), [
    ['m1', 'cancel-orders'],
    ['m2', 'order-history'],
    ['m3', 'order-history'],
    ['m4', 'refunds'],
  ]);
});

test('/setup lands in Other: no change, the command recorded, also for its subagents', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_s', r.tick()));
  r.rec.commandBefore(command('ses_s', 'setup', 'Acme Orders - lets small shops take orders'));
  r.rec.event(reply('m1', 'ses_s', r.tick()));
  r.rec.event(session('ses_p', r.tick(), 'ses_s'));
  r.rec.event(reply('m2', 'ses_p', r.tick(), { agent: 'platform' }));
  assert.deepEqual(r.replies(), [
    { id: 'm1', change_name: null, command: 'setup', agent: 'senior-dev' },
    { id: 'm2', change_name: null, command: 'setup', agent: 'platform' },
  ]);
});

test('the path fallback tags an unnamed session once and never replaces its change', async (t) => {
  const r = await setup(t);
  r.rec.event(session('ses_a', r.tick()));
  r.rec.toolAfter(read('ses_a', 'openspec/changes/archive/2026-09-29-cancel-orders/status.md'));
  r.rec.toolAfter({ tool: 'edit', sessionID: 'ses_a', callID: 'c', args: { filePath: 'README.md', oldString: 'openspec/changes/other/', newString: 'x' } });
  r.rec.event(reply('m1', 'ses_a', r.tick()));
  r.rec.toolAfter(read('ses_a', 'C:\\work\\my project\\openspec\\changes\\cancel-orders\\status.md'));
  r.rec.toolAfter(read('ses_a', 'openspec/changes/order-history/tasks.md'));
  r.rec.event(reply('m2', 'ses_a', r.tick()));
  r.rec.toolAfter(bash('ses_b', 'openspec status --change "order-history" --json'));
  r.rec.event(reply('m3', 'ses_b', r.tick()));
  assert.deepEqual(r.replies().map((x) => [x.id, x.change_name]), [
    ['m1', 'cancel-orders'],
    ['m2', 'cancel-orders'],
    ['m3', 'order-history'],
  ]);
});

test('odd reply shapes are recorded with fallbacks', async (t) => {
  const r = await setup(t);
  const completed = r.tick();
  r.rec.event({
    event: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'm1', sessionID: 'ses_old', role: 'assistant', mode: 'build', modelID: 'llama3.1:8b',
          time: { created: completed - 10, completed }, tokens: { input: 5, output: -3, reasoning: Number.NaN },
        },
      },
    },
  });
  assert.deepEqual(plain(r.db.prepare('SELECT agent, model, input, output, reasoning, cache_read, cache_write, cost FROM reply').all()), [
    { agent: 'build', model: 'llama3.1:8b', input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0 },
  ]);
  assert.deepEqual(r.warnings, []);
});

test('malformed events are skipped without throwing, with one warning per session', async (t) => {
  const r = await setup(t);
  const broken = (sessionID) => ({
    event: { type: 'message.updated', properties: { info: { id: 'x', sessionID, role: 'assistant', time: { created: 1, completed: 2 } } } },
  });
  assert.doesNotThrow(() => {
    r.rec.event(broken('ses_a'));
    r.rec.event(broken('ses_a'));
    r.rec.event(broken('ses_b'));
    r.rec.event(null);
    r.rec.event({});
    r.rec.event({ event: { type: 'message.updated' } });
    r.rec.commandBefore(null);
    r.rec.toolAfter(undefined);
  });
  assert.equal(r.warnings.length, 2);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM reply').get().n, 0);
});

test('a database that cannot be opened never throws into opencode', () => {
  const warnings = [];
  const rec = createRecorder({
    open: () => {
      throw new Error('disk I/O error');
    },
    warn: (m) => warnings.push(m),
  });
  assert.doesNotThrow(() => {
    rec.event(session('ses_x', 1));
    rec.commandBefore(command('ses_x', 'feature'));
    rec.toolAfter(bash('ses_x', 'openspec new change "a" --schema vsa-tdd'));
    rec.event(reply('m1', 'ses_x', 2));
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /disk I\/O error/);
});

test('two recorders on one database lose nothing', async (t) => {
  const project = makeProject();
  const a = await openDb(project.root);
  const b = await openDb(project.root);
  t.after(() => {
    a.close();
    b.close();
    project.cleanup();
  });
  const recA = createRecorder({ open: () => a });
  const recB = createRecorder({ open: () => b });
  for (let i = 0; i < 50; i++) {
    recA.event(reply(`a${i}`, 'ses_a', 1000 + i));
    recB.event(reply(`b${i}`, 'ses_b', 1000 + i));
    if (i === 25) {
      recA.toolAfter(bash('ses_a', 'openspec new change "one" --schema vsa-tdd'));
      recB.toolAfter(bash('ses_b', 'openspec new change "two" --schema vsa-tdd'));
    }
  }
  const counts = plain(a.prepare('SELECT change_name, COUNT(*) AS n FROM reply GROUP BY change_name ORDER BY change_name').all());
  assert.deepEqual(counts, [
    { change_name: 'one', n: 50 },
    { change_name: 'two', n: 50 },
  ]);
});
