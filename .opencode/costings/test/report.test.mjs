import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentColors, changeFolderInfo, csvCell, readUsage, repliesCsv, summaryCsv } from '../report.mjs';
import { FIXTURE, makeProject, openDb, writeFixture } from './_helpers.mjs';

const OPUS = 'anthropic/claude-opus-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const lines = (csv) => csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);

async function fixture(t) {
  const project = makeProject();
  await writeFixture(project.root);
  const db = await openDb(project.root);
  t.after(() => {
    db.close();
    project.cleanup();
  });
  return { root: project.root, db };
}

test('readUsage: changes newest first, per-agent tokens and runs, and Other', async (t) => {
  const { root, db } = await fixture(t);
  const usage = readUsage(db, root);
  assert.equal(usage.recorded, true);
  assert.deepEqual(usage.changes.map((c) => c.name), ['fix-login-redirect', 'cancel-orders']);
  const [bug, feature] = usage.changes;
  assert.deepEqual(
    { ...feature, agents: undefined, totals: undefined },
    {
      name: 'cancel-orders', type: 'feature', status: 'finished', finishedAt: '2026-09-29T12:00:00.000Z',
      summary: 'Customers can cancel orders', phase: null, firstActivity: '2026-09-28T09:05:00.000Z',
      lastActivity: '2026-09-29T12:00:00.000Z', agents: undefined, totals: undefined,
    },
  );
  assert.deepEqual(feature.totals, { runs: 4, input: 700, output: 80, reasoning: 15, cacheRead: 7000, cacheWrite: 170, total: FIXTURE.cancelOrders.total, cost: 0.27 });
  assert.deepEqual(feature.agents, [
    { agent: 'senior-dev', models: [OPUS], runs: 1, input: 300, output: 30, reasoning: 5, cacheRead: 3000, cacheWrite: 50, total: 3385, cost: 0.13 },
    { agent: 'test-writer', models: [SONNET], runs: 2, input: 100, output: 10, reasoning: 0, cacheRead: 1000, cacheWrite: 20, total: 1130, cost: 0.02 },
    { agent: 'developer', models: [SONNET], runs: 1, input: 300, output: 40, reasoning: 10, cacheRead: 3000, cacheWrite: 100, total: 3450, cost: 0.12 },
  ]);
  assert.deepEqual([bug.type, bug.status, bug.phase, bug.finishedAt, bug.summary, bug.lastActivity], ['bug', 'open', 'plan', null, null, '2026-10-03T08:30:00.000Z']);
  assert.deepEqual(bug.agents.map((a) => [a.agent, a.runs, a.total]), [['senior-dev', 1, 111], ['debugger', 1, 228]]);
  assert.equal(bug.totals.total, FIXTURE.fixLoginRedirect.total);
  assert.deepEqual(usage.other.map((o) => [o.command, o.label, o.type, o.lastActivity, o.totals.total, o.agents.map((a) => a.agent)]), [
    ['setup', '/setup', 'other', '2026-09-20T10:00:00.000Z', FIXTURE.setup.total, ['platform']],
  ]);
});

test('readUsage without a database says nothing is recorded, and still has the agent colours', () => {
  const project = makeProject();
  try {
    assert.deepEqual(readUsage(null, project.root), { recorded: false, changes: [], other: [], agentColors: agentColors(project.root) });
  } finally {
    project.cleanup();
  }
});

test('agentColors reads the color: line of every agent file', () => {
  const project = makeProject();
  try {
    assert.deepEqual(agentColors(project.root), {
      debugger: '#DC2626',
      developer: '#16A34A',
      platform: '#F59E0B',
      'senior-dev': '#7C3AED',
      'test-reviewer': '#0891B2',
      'test-writer': '#0EA5E9',
    });
  } finally {
    project.cleanup();
  }
});

test('changeFolderInfo: the folder wins, then the fix- naming rule', () => {
  const project = makeProject();
  try {
    const moved = path.join(project.root, 'openspec', 'changes', 'fix-renamed');
    mkdirSync(moved, { recursive: true });
    writeFileSync(path.join(moved, '.openspec.yaml'), 'schema: vsa-tdd\n'); // a bug that moved to the feature track
    writeFileSync(path.join(moved, 'status.md'), 'type: bug\r\nphase: green\r\n');
    assert.deepEqual(changeFolderInfo(project.root, 'fix-renamed'), { type: 'feature', phase: 'green' });
    assert.deepEqual(changeFolderInfo(project.root, 'fix-gone'), { type: 'bug', phase: null });
    assert.deepEqual(changeFolderInfo(project.root, 'order-history'), { type: 'feature', phase: null });
  } finally {
    project.cleanup();
  }
});

test('summaryCsv: one row per change, agent and model, then Other; filters by type', async (t) => {
  const { root, db } = await fixture(t);
  const csv = summaryCsv(db, root);
  assert.ok(csv.startsWith('\uFEFFchange,type,status,finished,agent,model,runs,input,output,reasoning,cache_read,cache_write,total,cost_usd\r\n'));
  assert.ok(csv.endsWith('\r\n'));
  assert.deepEqual(lines(csv).slice(1), [
    `fix-login-redirect,bug,open,,senior-dev,${OPUS},1,10,1,0,100,0,111,0.002`,
    `fix-login-redirect,bug,open,,debugger,${OPUS},1,20,2,1,200,5,228,0.004`,
    `cancel-orders,feature,finished,2026-09-29T12:00:00.000Z,senior-dev,${OPUS},1,300,30,5,3000,50,3385,0.13`,
    `cancel-orders,feature,finished,2026-09-29T12:00:00.000Z,test-writer,${SONNET},2,100,10,0,1000,20,1130,0.02`,
    `cancel-orders,feature,finished,2026-09-29T12:00:00.000Z,developer,${SONNET},1,300,40,10,3000,100,3450,0.12`,
    `/setup,other,,,platform,${SONNET},1,5,1,0,50,0,56,0.001`,
  ]);
  assert.deepEqual(lines(summaryCsv(db, root, 'bug')).slice(1).map((l) => l.split(',')[4]), ['senior-dev', 'debugger']);
  assert.deepEqual(lines(summaryCsv(db, root, 'other')).slice(1), [`/setup,other,,,platform,${SONNET},1,5,1,0,50,0,56,0.001`]);
  assert.equal(summaryCsv(null, root), '\uFEFFchange,type,status,finished,agent,model,runs,input,output,reasoning,cache_read,cache_write,total,cost_usd\r\n');
});

test('repliesCsv: one row per reply, oldest first, with the parent session', async (t) => {
  const { root, db } = await fixture(t);
  const rows = lines(repliesCsv(db, root));
  assert.equal(rows[0], 'completed,change,type,agent,model,session,parent_session,input,output,reasoning,cache_read,cache_write,total,cost_usd');
  assert.equal(rows.length, 9);
  assert.equal(rows[1], `2026-09-20T10:00:00.000Z,/setup,other,platform,${SONNET},ses_setup,,5,1,0,50,0,56,0.001`);
  assert.equal(rows[4], `2026-09-28T10:00:00.000Z,cancel-orders,feature,test-writer,${SONNET},ses_tw1,ses_plan,50,5,0,500,10,565,0.01`);
  assert.equal(rows[8], `2026-10-03T08:30:00.000Z,fix-login-redirect,bug,debugger,${OPUS},ses_dbg,ses_bug,20,2,1,200,5,228,0.004`);
  assert.equal(lines(repliesCsv(db, root, 'feature')).length, 6);
});

test('csvCell quotes what needs quoting and defuses formulas', () => {
  assert.equal(csvCell(12), '12');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('-x'), "'-x");
  assert.equal(csvCell('@sum'), "'@sum");
});
