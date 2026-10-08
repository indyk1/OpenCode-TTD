// Launcher tests: `--open --detach` (as /diagram and /classes run it) must return promptly with its output captured,
// print the address of the page it was asked for, leave the server running, reuse it on the next call, and step past
// a port held by another page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DIAGRAMS_DIR, PROJECT_ROOT, SERVER, freePort, makeProject, request } from './_helpers.mjs';

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

/** Stop the server on `port` and wait until its process has exited - on Windows a live process keeps the project folder locked. */
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
  throw new Error(`server on ${port} (pid ${pid}) did not stop`);
}

test('/diagram and /classes run the launcher these tests exercise', () => {
  const command = (name) => readFileSync(path.join(PROJECT_ROOT, '.opencode', 'commands', `${name}.md`), 'utf8');
  assert.match(command('diagram'), /!`node \.opencode\/diagrams\/server\.mjs --page architecture --open --detach 2>&1`/);
  assert.match(command('diagram'), /starts with "Architecture diagram running at"/);
  assert.match(command('classes'), /!`node \.opencode\/diagrams\/server\.mjs --page classes --open --detach 2>&1`/);
  assert.match(command('classes'), /starts with "Class diagram running at"/);
});

test('--detach starts one background server for both pages, prints the page asked for, and is reused', async (t) => {
  const project = makeProject();
  const port = await freePort();
  t.after(async () => {
    await shutdown(port).catch(() => {});
    project.cleanup();
  });
  const first = await runCaptured(['--root', project.root, '--port', String(port), '--open', '--detach', '--no-open']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.ok(first.ms < 5000, `took ${first.ms}ms`);
  assert.equal(first.stdout, `Architecture diagram running at http://127.0.0.1:${port}\n`);
  assert.equal(first.stderr, '');
  const h1 = await health(port);
  assert.deepEqual([h1.app, h1.root], ['opencode-diagrams', path.resolve(project.root)]);
  const second = await runCaptured(['--root', project.root, '--port', String(port), '--page', 'classes', '--open', '--detach', '--no-open']);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, `Class diagram running at http://127.0.0.1:${port}/classes\n`);
  assert.equal((await health(port)).pid, h1.pid);
});

test('--detach steps past a port held by the token usage page', async (t) => {
  const project = makeProject();
  const port = await freePort();
  const other = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'opencode-costings', root: project.root }));
  });
  await new Promise((resolve) => other.listen(port, '127.0.0.1', resolve));
  let started = 0;
  t.after(async () => {
    if (started) await shutdown(started).catch(() => {});
    other.closeAllConnections();
    other.close();
    project.cleanup();
  });
  const r = await runCaptured(['--root', project.root, '--port', String(port), '--page', 'classes', '--detach', '--no-open']);
  started = Number(/^Class diagram running at http:\/\/127\.0\.0\.1:(\d+)\/classes\n$/.exec(r.stdout)?.[1]);
  assert.ok(started > port, r.stdout + r.stderr);
  assert.equal((await health(started)).app, 'opencode-diagrams');
});

test('the launcher reports a missing project and a wrong page on stdout or stderr', async () => {
  const missing = await runCaptured(['--root', path.join(DIAGRAMS_DIR, 'no-such-project'), '--detach', '--no-open']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^Diagram page could not start: no \.opencode folder/);
  const wrong = await runCaptured(['--page', 'everything', '--detach', '--no-open']);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /--page must be architecture or classes/);
});
