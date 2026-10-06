// Shared helpers for the token usage tests (not a test file itself).
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, prepareForWriting } from '../schema.mjs';
import { loadSqlite } from '../sqlite.mjs';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const COSTINGS_DIR = path.resolve(TEST_DIR, '..');
export const PROJECT_ROOT = path.resolve(COSTINGS_DIR, '..', '..');
export const SERVER = path.join(COSTINGS_DIR, 'server.mjs');

/** A throwaway project whose path contains a space, with the real agent files (for their colours) and .workflow/. */
export function makeProject() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'costings-'));
  const root = path.join(parent, 'my project');
  mkdirSync(path.join(root, '.opencode'), { recursive: true });
  mkdirSync(path.join(root, '.workflow'), { recursive: true });
  cpSync(path.join(PROJECT_ROOT, '.opencode', 'agents'), path.join(root, '.opencode', 'agents'), { recursive: true });
  return { root, cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/** The project's usage database, created if needed and prepared for writing. Close it when done. */
export async function openDb(root) {
  const DatabaseSync = await loadSqlite();
  return prepareForWriting(new DatabaseSync(dbPath(root)));
}

export const at = (iso) => Date.parse(iso);

/** node:sqlite rows have a null prototype; strict deepEqual needs plain objects. */
export const plain = (rows) => rows.map((row) => ({ ...row }));
