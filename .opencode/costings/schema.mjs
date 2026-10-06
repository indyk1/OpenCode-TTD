// The token usage database, .workflow/usage.db: one schema for the opencode plugin (bun:sqlite) and the Node
// scripts (node:sqlite). SQL here and in the modules that use it takes positional ? parameters only, so the same
// statements run on both drivers.
import path from 'node:path';

export const SCHEMA_VERSION = 1;

/** Every token kind, each counted once: opencode reports input without the cache tokens and output without reasoning. */
export const TOTAL_SQL = '(input + output + reasoning + cache_read + cache_write)';

export function dbPath(root) {
  return path.join(root, '.workflow', 'usage.db');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  change_name TEXT,
  command     TEXT,
  command_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reply (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  change_name  TEXT,
  command      TEXT,
  agent        TEXT NOT NULL,
  model        TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  reasoning    INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  cost         REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS finished_change (
  name        TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  summary     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reply_change ON reply(change_name);
CREATE INDEX IF NOT EXISTS reply_session ON reply(session_id);
CREATE INDEX IF NOT EXISTS session_parent ON session(parent_id);
`;

export class NewerSchemaError extends Error {
  constructor(found) {
    super(
      `This usage database was written by a newer version of the template (schema ${found}; this one knows ${SCHEMA_VERSION}) - update .opencode/costings/.`,
    );
    this.name = 'NewerSchemaError';
    this.found = found;
  }
}

export function schemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/** Make a freshly opened connection ready for writing: busy timeout, WAL, tables. Returns `db`. */
export function prepareForWriting(db) {
  db.exec('PRAGMA busy_timeout = 5000');
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) throw new NewerSchemaError(version);
  db.exec('PRAGMA journal_mode = WAL');
  if (version < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

/** Check a connection opened for reading. False when the database has no tables yet. */
export function checkReadable(db) {
  db.exec('PRAGMA busy_timeout = 5000');
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) throw new NewerSchemaError(version);
  return version === SCHEMA_VERSION;
}
