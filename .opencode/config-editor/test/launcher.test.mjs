// Launcher tests: `--open --detach` must return promptly even when stdout is a captured pipe (that is how
// opencode runs !`cmd` in a command template), leave the editor running, and reuse it on the next call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { SERVER, childEnv, freePort, makeProject, request } from './_helpers.mjs';

const LINE_RE = /^Config editor running at http:\/\/127\.0\.0\.1:(\d+) \(saved changes apply after you restart opencode\)\n$/;

/** Run a command with stdout/stderr piped and wait for 'close', i.e. until every holder of the pipe has let go. */
function runCaptured(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function health(port) {
  const res = await request(port, { path: '/api/health' });
  return res.json;
}

async function shutdown(port) {
  await request(port, { method: 'POST', path: '/api/shutdown', body: {} }).catch(() => {});
  for (let i = 0; i < 50; i++) {
    try {
      await health(port);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`editor on ${port} did not stop`);
}

test('--open --detach starts a background editor, prints one line and returns quickly', async (t) => {
  const project = makeProject();
  const port = await freePort();
  const env = childEnv();
  t.after(async () => {
    await shutdown(port).catch(() => {});
    project.cleanup();
  });

  // Exactly as the /config command runs it: through a shell, output captured, 2>&1.
  const first = await runCaptured('/bin/sh', ['-c', `"${process.execPath}" "${SERVER}" --root "${project.root}" --port ${port} --open --detach --no-open 2>&1`], env);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.ok(first.ms < 5000, `took ${first.ms}ms`);
  const m = LINE_RE.exec(first.stdout);
  assert.ok(m, JSON.stringify(first.stdout));
  assert.equal(Number(m[1]), port);

  const h1 = await health(port);
  assert.equal(h1.app, 'opencode-config-editor');
  assert.equal(h1.root, project.root);
  assert.notEqual(h1.pid, undefined);

  // The editor outlives the launcher and serves the API.
  const agents = await request(port, { path: '/api/agents' });
  assert.equal(agents.json.agents.length, 6);

  // A second launch reuses the running editor instead of starting another one.
  const second = await runCaptured(process.execPath, [SERVER, '--root', project.root, '--port', String(port), '--open', '--detach', '--no-open'], env);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, first.stdout);
  assert.ok(second.ms < 3000, `reuse took ${second.ms}ms`);
  assert.equal((await health(port)).pid, h1.pid);

  await shutdown(port);
});

test('--detach skips a port held by something else, and one held by an editor for another project', async (t) => {
  const port = await freePort();
  const squatter = http.createServer((req, res) => res.end('not the editor'));
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  const other = makeProject();
  const project = makeProject();
  const env = childEnv();
  const started = [];
  t.after(async () => {
    for (const p of started) await shutdown(p).catch(() => {});
    squatter.close();
    other.cleanup();
    project.cleanup();
  });

  const a = await runCaptured(process.execPath, [SERVER, '--root', other.root, '--port', String(port), '--detach'], env);
  const portA = Number(LINE_RE.exec(a.stdout)?.[1]);
  started.push(portA);
  assert.ok(portA > port, a.stdout);
  assert.equal((await health(portA)).root, other.root);

  const b = await runCaptured(process.execPath, [SERVER, '--root', project.root, '--port', String(port), '--detach'], env);
  const portB = Number(LINE_RE.exec(b.stdout)?.[1]);
  started.push(portB);
  assert.ok(portB > portA, b.stdout);
  assert.equal((await health(portB)).root, project.root);
});

test('the launcher reports a missing project on stdout', async () => {
  const res = await runCaptured(process.execPath, [SERVER, '--root', '/nonexistent-project-dir', '--detach', '--no-open'], childEnv());
  assert.equal(res.code, 1);
  assert.match(res.stdout, /^Config editor could not start: no \.opencode folder/);
});
