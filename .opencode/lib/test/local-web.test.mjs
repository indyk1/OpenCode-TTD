import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import * as editorLib from '../../config-editor/lib.mjs';
import { HttpError, browserCommands, checkRequest, findPort, isWsl, parseLauncherArgs, probe } from '../local-web.mjs';

const req = (method, headers, url = '/') => ({ method, url, headers });

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function jsonServer(body) {
  return http.createServer((rq, rs) => {
    rs.setHeader('Content-Type', 'application/json');
    rs.end(JSON.stringify(body));
  });
}

test('checkRequest accepts our own page and refuses foreign hosts, bodies and origins', () => {
  const port = 4330;
  assert.equal(checkRequest(req('GET', { host: '127.0.0.1:4330' }, '/api/usage?filter=bug'), port).searchParams.get('filter'), 'bug');
  assert.ok(checkRequest(req('GET', { host: 'LOCALHOST:4330' }), port));
  assert.throws(() => checkRequest(req('GET', { host: 'evil.example:4330' }), port), (e) => e instanceof HttpError && e.status === 403 && e.message === 'Forbidden host');
  assert.throws(() => checkRequest(req('GET', {}), port), { status: 403 });
  assert.throws(() => checkRequest(req('POST', { host: '127.0.0.1:4330', 'content-type': 'text/plain' }), port), { status: 415 });
  assert.throws(
    () => checkRequest(req('POST', { host: '127.0.0.1:4330', 'content-type': 'application/json', origin: 'http://evil.example' }), port),
    { status: 403, message: 'Forbidden origin' },
  );
  assert.ok(checkRequest(req('POST', { host: '127.0.0.1:4330', 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:4330' }), port));
});

test('parseLauncherArgs reads the shared options and page-specific value flags', () => {
  const base = { defaultRoot: path.resolve('/project'), defaultPort: 4330 };
  assert.deepEqual(parseLauncherArgs([], base), {
    root: path.resolve('/project'),
    port: 4330,
    open: false,
    noOpen: false,
    detach: false,
    idleMinutes: 15,
    strictPort: false,
    help: false,
  });
  const o = parseLauncherArgs(['--open', '--no-open', '--port=0', '--idle-minutes', '0', '--root', 'x', '--csv', 'summary'], {
    ...base,
    valueFlags: { '--csv': 'csv' },
  });
  assert.deepEqual([o.open, o.port, o.idleMinutes, o.root, o.csv], [false, 0, 0, path.resolve('x'), 'summary']);
  assert.throws(() => parseLauncherArgs(['--csv', 'x'], base), /Unknown option: --csv/);
  assert.throws(() => parseLauncherArgs(['--port', '70000'], base), /--port must be a whole number from 0 to 65535/);
  assert.throws(() => parseLauncherArgs(['--root'], base), /--root needs a value/);
});

test('findPort reuses our server for this project and skips everything else', async (t) => {
  const root = path.resolve('/my/project');
  const squatter = http.createServer((rq, rs) => rs.end('not ours'));
  const other = jsonServer({ app: 'test-app', root: path.resolve('/other/project') });
  const ours = jsonServer({ app: 'test-app', root });
  const [squatterPort, otherPort, oursPort] = [await listen(squatter), await listen(other), await listen(ours)];
  t.after(() => {
    for (const s of [squatter, other, ours]) {
      s.closeAllConnections();
      s.close();
    }
  });
  const find = (start) => findPort({ appId: 'test-app', root, start, attempts: 1 });
  assert.equal(await find(squatterPort), null);
  assert.equal(await find(otherPort), null);
  assert.deepEqual(await find(oursPort), { port: oursPort, reuse: true });
  const free = await freePort();
  assert.deepEqual(await find(free), { port: free, reuse: false });
  assert.deepEqual(await probe(oursPort, 'another-app'), { state: 'taken' });
});

test('the config editor re-exports the shared browser launcher', () => {
  assert.equal(editorLib.browserCommands, browserCommands);
  assert.equal(editorLib.isWsl, isWsl);
});
