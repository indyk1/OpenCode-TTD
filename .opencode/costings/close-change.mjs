#!/usr/bin/env node
// Marks a change finished in the token usage database (.workflow/usage.db). Run by scripts/finish-change.sh
// after the change is archived:
//
//   node .opencode/costings/close-change.mjs <change> <feature|bug> "<summary>"
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../lib/local-web.mjs';
import { TOTAL_SQL, dbPath, prepareForWriting } from './schema.mjs';
import { loadSqlite } from './sqlite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TYPES = ['feature', 'bug'];

/** Insert or replace the change's finished_change row. Returns its reply count and token total. */
export function closeChange(db, { name, type, summary, finishedAt = Date.now() }) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === 'archive') throw new Error(`not a change name: ${JSON.stringify(name)}`);
  if (!TYPES.includes(type)) throw new Error(`type must be feature or bug, not ${JSON.stringify(type)}`);
  db.prepare('INSERT OR REPLACE INTO finished_change (name, type, finished_at, summary) VALUES (?, ?, ?, ?)').run(
    name,
    type,
    finishedAt,
    String(summary ?? ''),
  );
  const totals = db
    .prepare(`SELECT COUNT(*) AS replies, COALESCE(SUM(${TOTAL_SQL}), 0) AS total FROM reply WHERE change_name = ?`)
    .get(name);
  return { replies: Number(totals.replies), total: Number(totals.total) };
}

export async function main(argv = process.argv.slice(2), { root = ROOT, log = console.log } = {}) {
  const [name, type, summary = ''] = argv;
  const DatabaseSync = await loadSqlite();
  const file = dbPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = prepareForWriting(new DatabaseSync(file));
  try {
    const { replies, total } = closeChange(db, { name, type, summary });
    log(`Token usage for ${name}: ${total.toLocaleString('en-US')} tokens over ${replies} model replies.`);
  } finally {
    db.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(`close-change: ${err.message}`);
    process.exit(1);
  });
}
