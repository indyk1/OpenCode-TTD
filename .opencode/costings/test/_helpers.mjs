// Shared helpers for the token usage tests (not a test file itself).
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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

/**
 * The fixture behind the report, server and UI tests. Writes .workflow/usage.db and the open bug's change folder:
 * - cancel-orders: finished feature (2026-09-29 12:00Z); senior-dev 1 run, test-writer 2 runs, developer 1 run.
 * - fix-login-redirect: open bug (folder says vsa-tdd-bugfix, phase plan); senior-dev and a debugger subagent.
 * - /setup: work outside a change; platform.
 */
export async function writeFixture(root) {
  const opus = 'anthropic/claude-opus-5-5';
  const sonnet = 'anthropic/claude-sonnet-5-5';
  const db = await openDb(root);
  const insertSession = db.prepare('INSERT INTO session (id, parent_id, change_name, command, command_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, parent, change, command, created] of [
    ['ses_plan', null, 'cancel-orders', 'feature', '2026-09-28T09:00:00Z'],
    ['ses_tw1', 'ses_plan', 'cancel-orders', 'feature', '2026-09-28T09:55:00Z'],
    ['ses_tw2', 'ses_plan', 'cancel-orders', 'feature', '2026-09-28T10:55:00Z'],
    ['ses_dev', 'ses_plan', 'cancel-orders', 'feature', '2026-09-29T08:55:00Z'],
    ['ses_bug', null, 'fix-login-redirect', 'bug', '2026-10-03T07:55:00Z'],
    ['ses_dbg', 'ses_bug', 'fix-login-redirect', 'bug', '2026-10-03T08:10:00Z'],
    ['ses_setup', null, null, 'setup', '2026-09-20T09:55:00Z'],
  ]) {
    insertSession.run(id, parent, change, command, at(created), at(created));
  }
  const insertReply = db.prepare(
    `INSERT INTO reply (id, session_id, change_name, command, agent, model, completed_at, input, output, reasoning, cache_read, cache_write, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, session, change, command, agent, model, completed, ...counts] of [
    // id, session, change, command, agent, model, completed, input, output, reasoning, cache read, cache write, cost
    ['r1', 'ses_plan', 'cancel-orders', 'feature', 'senior-dev', opus, '2026-09-28T09:05:00Z', 100, 10, 5, 1000, 50, 0.05],
    ['r2', 'ses_plan', 'cancel-orders', 'feature', 'senior-dev', opus, '2026-09-28T09:30:00Z', 200, 20, 0, 2000, 0, 0.08],
    ['r3', 'ses_tw1', 'cancel-orders', 'feature', 'test-writer', sonnet, '2026-09-28T10:00:00Z', 50, 5, 0, 500, 10, 0.01],
    ['r4', 'ses_tw2', 'cancel-orders', 'feature', 'test-writer', sonnet, '2026-09-28T11:00:00Z', 50, 5, 0, 500, 10, 0.01],
    ['r5', 'ses_dev', 'cancel-orders', 'feature', 'developer', sonnet, '2026-09-29T09:00:00Z', 300, 40, 10, 3000, 100, 0.12],
    ['r6', 'ses_bug', 'fix-login-redirect', 'bug', 'senior-dev', opus, '2026-10-03T08:00:00Z', 10, 1, 0, 100, 0, 0.002],
    ['r7', 'ses_dbg', 'fix-login-redirect', 'bug', 'debugger', opus, '2026-10-03T08:30:00Z', 20, 2, 1, 200, 5, 0.004],
    ['r8', 'ses_setup', null, 'setup', 'platform', sonnet, '2026-09-20T10:00:00Z', 5, 1, 0, 50, 0, 0.001],
  ]) {
    insertReply.run(id, session, change, command, agent, model, at(completed), ...counts);
  }
  db.prepare('INSERT INTO finished_change (name, type, finished_at, summary) VALUES (?, ?, ?, ?)').run(
    'cancel-orders',
    'feature',
    at('2026-09-29T12:00:00Z'),
    'Customers can cancel orders',
  );
  db.close();
  const change = path.join(root, 'openspec', 'changes', 'fix-login-redirect');
  mkdirSync(change, { recursive: true });
  writeFileSync(path.join(change, '.openspec.yaml'), 'schema: vsa-tdd-bugfix\r\ncreated: 2026-10-03\r\n');
  writeFileSync(path.join(change, 'status.md'), '# fix-login-redirect\ntype: bug\nphase: plan\nupdated: 2026-10-03 08:30\n');
}

export const FIXTURE = {
  cancelOrders: { total: 7965, runs: 4 },
  fixLoginRedirect: { total: 339, runs: 2 },
  setup: { total: 56 },
};

/** Start server.mjs in the foreground on a random port and wait for its "running at" line. */
export function startServer({ root, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--root', root, '--port', '0', '--no-open', '--idle-minutes', '0', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}${err}`)), 5000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      const m = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        const port = Number(m[1]);
        resolve({ child, port, url: `http://127.0.0.1:${port}`, stop: () => stopChild(child) });
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}${err}`)));
  });
}

export function waitForExit(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit')), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForExit(child).catch(() => child.kill('SIGKILL'));
}

/** Raw HTTP request (fetch cannot set Host). Returns { status, headers, text, json }. */
export function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
