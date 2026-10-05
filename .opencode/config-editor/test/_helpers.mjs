// Shared helpers for the config editor tests (not a test file itself).
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EDITOR_DIR = path.resolve(TEST_DIR, '..');
export const PROJECT_ROOT = path.resolve(EDITOR_DIR, '..', '..');
export const SERVER = path.join(EDITOR_DIR, 'server.mjs');
export const AGENTS_DIR = path.join(PROJECT_ROOT, '.opencode', 'agents');

/** A throwaway copy of the project's agent files and opencode.json. */
export function makeProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'config-editor-'));
  mkdirSync(path.join(root, '.opencode'), { recursive: true });
  cpSync(AGENTS_DIR, path.join(root, '.opencode', 'agents'), { recursive: true });
  cpSync(path.join(PROJECT_ROOT, 'opencode.json'), path.join(root, 'opencode.json'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fake `opencode` on a private bin dir. It logs its arguments and prints a different list for --refresh. */
export function makeFakeOpencode(dir, { fail = false } = {}) {
  const bin = path.join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'fake-opencode.log');
  const script = fail
    ? `#!/bin/sh\necho "boom: provider config is broken" >&2\nexit 3\n`
    : `#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" != "models" ]; then echo "unexpected: $*" >&2; exit 2; fi
if [ "$2" = "--refresh" ]; then
  printf '\\033[1m\\033[32mModels cache refreshed\\033[0m\\n'
  printf 'anthropic/claude-opus-5-5\\nanthropic/claude-opus-6\\nanthropic/claude-sonnet-5-5\\nopenai/gpt-5.2\\n'
else
  printf 'INFO  2026-10-05T10:00:00 +12ms service=models loading cache\\n\\n'
  printf '\\033[0manthropic/claude-opus-5-5\\033[0m\\r\\n'
  printf 'anthropic/claude-sonnet-5-5\\n\\n   anthropic/claude-haiku-4-5   \\n'
  printf 'openai/gpt-5.1\\n'
fi
`;
  writeFileSync(path.join(bin, 'opencode'), script);
  chmodSync(path.join(bin, 'opencode'), 0o755);
  return { bin, log };
}

/** Environment for a child server: PATH limited as asked, no API key leaking in from the outer shell. */
export function childEnv({ pathDirs = [], extra = {} } = {}) {
  const env = { ...process.env, PATH: [...pathDirs, '/usr/bin', '/bin'].join(path.delimiter), ...extra };
  if (!('ANTHROPIC_API_KEY' in extra)) delete env.ANTHROPIC_API_KEY;
  if (!('ANTHROPIC_BASE_URL' in extra)) delete env.ANTHROPIC_BASE_URL;
  return env;
}

/** Start server.mjs in the foreground on a random port and wait for its "running at" line. */
export function startServer({ root, env = childEnv(), args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--root', root, '--port', '0', '--no-open', '--idle-minutes', '0', ...args], {
      env,
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
    const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
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

/** Line-by-line comparison: indexes of lines that differ (inputs must have the same number of lines). */
export function differingLines(a, b) {
  const la = a.split(/(?<=\n)/);
  const lb = b.split(/(?<=\n)/);
  if (la.length !== lb.length) throw new Error(`line counts differ: ${la.length} vs ${lb.length}`);
  return la.flatMap((line, i) => (line === lb[i] ? [] : [i]));
}
