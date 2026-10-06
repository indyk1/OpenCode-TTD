import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NewerSchemaError, SCHEMA_VERSION, TOTAL_SQL, checkReadable, dbPath, prepareForWriting } from '../schema.mjs';
import { loadSqlite } from '../sqlite.mjs';
import { COSTINGS_DIR, makeProject } from './_helpers.mjs';

async function fresh(t) {
  const project = makeProject();
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(dbPath(project.root));
  t.after(() => {
    db.close();
    project.cleanup();
  });
  return db;
}

test('prepareForWriting creates the tables in WAL mode, and a second call is harmless', async (t) => {
  const db = await fresh(t);
  assert.equal(checkReadable(db), false);
  prepareForWriting(db);
  prepareForWriting(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['finished_change', 'reply', 'session']);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(checkReadable(db), true);
});

test('TOTAL_SQL counts every token kind once', async (t) => {
  const db = prepareForWriting(await fresh(t));
  db.prepare(
    `INSERT INTO reply (id, session_id, change_name, command, agent, model, completed_at, input, output, reasoning, cache_read, cache_write, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('r1', 's1', 'cancel-orders', 'feature', 'senior-dev', 'anthropic/claude-opus-5-5', 1, 100, 10, 5, 1000, 50, 0.05);
  assert.equal(db.prepare(`SELECT ${TOTAL_SQL} AS total FROM reply`).get().total, 1165);
});

test('a database from a newer template is refused for writing and for reading', async (t) => {
  const db = await fresh(t);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => prepareForWriting(db), (err) => err instanceof NewerSchemaError && /newer version of the template/.test(err.message));
  assert.throws(() => checkReadable(db), NewerSchemaError);
});

test('loadSqlite hides only the SQLite experimental warning', () => {
  const url = pathToFileURL(path.join(COSTINGS_DIR, 'sqlite.mjs')).href;
  const script = `const { loadSqlite } = await import(${JSON.stringify(url)});
const A = await loadSqlite();
const B = await loadSqlite();
if (A !== B) process.exit(3);
new A(':memory:').close();
process.emitWarning('still shown');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /SQLite is an experimental/);
  assert.match(r.stderr, /still shown/);
});
