// Runs scripts/finish-change.sh in a throwaway git repository, with a stand-in `openspec` that archives the way
// the real one does. Needs bash (/bin/bash, or Git Bash on Windows; COSTINGS_TEST_BASH overrides); skipped without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dbPath } from '../schema.mjs';
import { PROJECT_ROOT, makeProject, openDb } from './_helpers.mjs';

function findBash() {
  if (process.env.COSTINGS_TEST_BASH) return process.env.COSTINGS_TEST_BASH;
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : null;
  return ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) ?? null;
}
const BASH = findBash();
const skip = BASH ? false : 'bash was not found (set COSTINGS_TEST_BASH)';
const SUMMARY = 'Fix the "login" redirect, for $HOME users';
const COPIES = [
  'scripts/finish-change.sh',
  'scripts/lib.sh',
  '.opencode/costings/close-change.mjs',
  '.opencode/costings/schema.mjs',
  '.opencode/costings/sqlite.mjs',
  '.opencode/lib/local-web.mjs',
  '.workflow/.gitignore',
];

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function makeRepo(t, { change, schema }) {
  const project = makeProject();
  t.after(() => project.cleanup());
  const { root } = project;
  for (const file of COPIES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(PROJECT_ROOT, file), path.join(root, file));
  }
  // The lock check is not under test here.
  writeFileSync(path.join(root, 'scripts', 'check-test-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const changeDir = path.join(root, 'openspec', 'changes', change);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(path.join(changeDir, '.openspec.yaml'), `schema: ${schema}\ncreated: 2026-10-06\n`);
  // A stand-in for the OpenSpec CLI: `archive <change> --yes` moves the folder, like the real one.
  const bin = path.join(path.dirname(root), 'fake bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, 'openspec'),
    '#!/usr/bin/env bash\nif [ "$1" = archive ]; then mkdir -p openspec/changes/archive && mv "openspec/changes/$2" "openspec/changes/archive/2026-10-06-$2"; exit 0; fi\necho "unexpected: $*" >&2\nexit 2\n',
  );
  chmodSync(path.join(bin, 'openspec'), 0o755);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  return { root, bin, change };
}

function finish(repo) {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = [repo.bin, path.dirname(process.execPath), env[key]].join(path.delimiter);
  return spawnSync(BASH, ['scripts/finish-change.sh', repo.change, SUMMARY], { cwd: repo.root, env, encoding: 'utf8' });
}

async function finishedRow(root) {
  const db = await openDb(root);
  const row = db.prepare('SELECT name, type, summary FROM finished_change').get();
  db.close();
  return row ? { ...row } : null;
}

test('finish-change.sh marks a bug finished in the usage database and saves the work', { skip }, async (t) => {
  const repo = makeRepo(t, { change: 'fix-login-redirect', schema: 'vsa-tdd-bugfix' });
  const r = finish(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Token usage for fix-login-redirect: 0 tokens over 0 model replies\./);
  assert.deepEqual(await finishedRow(repo.root), { name: 'fix-login-redirect', type: 'bug', summary: SUMMARY });
  assert.equal(git(repo.root, 'log', '-1', '--format=%s'), `fix-login-redirect: ${SUMMARY}`);
  assert.ok(!git(repo.root, 'ls-files').split('\n').includes('.workflow/usage.db'), 'usage.db must stay out of git');
  assert.ok(existsSync(path.join(repo.root, 'openspec', 'changes', 'archive', '2026-10-06-fix-login-redirect')));
});

test('finish-change.sh records the vsa-tdd schema as a feature', { skip }, async (t) => {
  const repo = makeRepo(t, { change: 'cancel-orders', schema: 'vsa-tdd' });
  const r = finish(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((await finishedRow(repo.root)).type, 'feature');
});

test('finish-change.sh still saves the work when the usage cannot be recorded', { skip }, async (t) => {
  const repo = makeRepo(t, { change: 'cancel-orders', schema: 'vsa-tdd' });
  mkdirSync(dbPath(repo.root)); // a folder where the database file should be
  const r = finish(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /warning: token usage for cancel-orders was not recorded/);
  assert.equal(git(repo.root, 'log', '-1', '--format=%s'), `cancel-orders: ${SUMMARY}`);
});
