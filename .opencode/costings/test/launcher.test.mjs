// Launcher tests: `--open --detach` (as /costings runs it) must return promptly with its output captured, leave the
// page running, reuse it on the next call, and step past a port held by the config editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { COSTINGS_DIR, PROJECT_ROOT, SERVER, freePort, makeProject, request } from './_helpers.mjs';

const LINE_RE = /^Token usage page running at http:\/\/127\.0\.0\.1:(\d+)\n$/;

/** Run the server with stdout/stderr piped and wait for 'close', i.e. until every holder of the pipe has let go. */
function runCaptured(args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`still running after 10s; stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

const health = async (port) => (await request(port, { path: '/api/health' })).json;

/** Stop the page on `port` and wait until its process has exited - on Windows a live process keeps the project folder locked. */
async function shutdown(port) {
  let pid;
  try {
    pid = (await health(port)).pid;
  } catch {
    return; // nothing is listening
  }
  await request(port, { method: 'POST', path: '/api/shutdown', body: {} }).catch(() => {});
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0); // signal 0 only checks that the process still exists
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`page on ${port} (pid ${pid}) did not stop`);
}

test('/costings runs the launcher these tests exercise', () => {
  const command = readFileSync(path.join(PROJECT_ROOT, '.opencode', 'commands', 'costings.md'), 'utf8');
  assert.match(command, /!`node \.opencode\/costings\/server\.mjs --open --detach 2>&1`/);
  assert.match(command, /starts with "Token usage page running at"/);
});

test('--open --detach starts a background page, prints one line, returns quickly and is reused', async (t) => {
  const project = makeProject();
  const port = await freePort();
  t.after(async () => {
    await shutdown(port).catch(() => {});
    project.cleanup();
  });
  const first = await runCaptured(['--root', project.root, '--port', String(port), '--open', '--detach', '--no-open']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.ok(first.ms < 5000, `took ${first.ms}ms`);
  assert.equal(Number(LINE_RE.exec(first.stdout)?.[1]), port, JSON.stringify(first.stdout));
  assert.equal(first.stderr, '');
  const h1 = await health(port);
  assert.deepEqual([h1.app, h1.root], ['opencode-costings', path.resolve(project.root)]);
  const second = await runCaptured(['--root', project.root, '--port', String(port), '--open', '--detach', '--no-open']);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, first.stdout);
  assert.equal((await health(port)).pid, h1.pid);
});

test('--detach steps past a port held by the config editor', async (t) => {
  const project = makeProject();
  const port = await freePort();
  const editor = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'opencode-config-editor', root: project.root }));
  });
  await new Promise((resolve) => editor.listen(port, '127.0.0.1', resolve));
  let started = 0;
  t.after(async () => {
    if (started) await shutdown(started).catch(() => {});
    editor.closeAllConnections();
    editor.close();
    project.cleanup();
  });
  const r = await runCaptured(['--root', project.root, '--port', String(port), '--detach', '--no-open']);
  started = Number(LINE_RE.exec(r.stdout)?.[1]);
  assert.ok(started > port, r.stdout + r.stderr);
  assert.equal((await health(started)).app, 'opencode-costings');
});

test('the launcher reports a missing project on stdout', async () => {
  const r = await runCaptured(['--root', path.join(COSTINGS_DIR, 'no-such-project'), '--detach', '--no-open']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^Token usage page could not start: no \.opencode folder/);
});
