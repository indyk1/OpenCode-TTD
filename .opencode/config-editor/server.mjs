#!/usr/bin/env node
// opencode config editor: a small local server that lets a browser page change each
// agent's `model:` and `variant:` in .opencode/agents/*.md. Zero dependencies, Node 20+.
//
//   node .opencode/config-editor/server.mjs --open            foreground, Ctrl+C to stop
//   node .opencode/config-editor/server.mjs --open --detach   start in the background and return (used by /config)
//
// Options: --root <dir>  --port <n> (default 4317)  --open / --no-open  --detach  --idle-minutes <n> (0 = never)

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APP_ID,
  applyChanges,
  browserCommands,
  countModels,
  parseModelsOutput,
  readAgents,
  readGlobalConfig,
} from './lib.mjs';

const SERVER_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SERVER_FILE);
const INDEX_FILE = path.join(HERE, 'index.html');
const DEFAULT_PORT = 4317;
const PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 64 * 1024;
const MODELS_TIMEOUT_MS = 45_000;
const START_TIMEOUT_MS = 5_000;
const RESTART_HINT = '(saved changes apply after you restart opencode)';

const USAGE = `Usage: node server.mjs [--open | --no-open] [--detach] [--port <n>] [--root <dir>] [--idle-minutes <n>]

  --open            open the editor in your browser
  --no-open         do not open the browser (overrides --open)
  --detach          start the editor in the background, print its URL and exit
  --port <n>        port to listen on (default ${DEFAULT_PORT}; the next few are tried if it is taken)
  --root <dir>      project root (default: two folders above this file)
  --idle-minutes n  stop after n minutes without requests (default 15, 0 = never)`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    root: path.resolve(HERE, '..', '..'),
    port: DEFAULT_PORT,
    open: false,
    noOpen: false,
    detach: false,
    idleMinutes: 15,
    strictPort: false, // internal: the detached child must use exactly the port its parent picked
    help: false,
  };
  const args = [...argv];
  const value = (flag) => {
    const v = args.shift();
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  const number = (flag, v, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number from ${min} to ${max}`);
    return n;
  };
  while (args.length) {
    let arg = args.shift();
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      args.unshift(arg.slice(eq + 1));
      arg = arg.slice(0, eq);
    }
    switch (arg) {
      case '--root': opts.root = path.resolve(value(arg)); break;
      case '--port': opts.port = number(arg, value(arg), 0, 65535); break;
      case '--idle-minutes': opts.idleMinutes = number(arg, value(arg), 0, 7 * 24 * 60); break;
      case '--open': opts.open = true; break;
      case '--no-open': opts.noOpen = true; break;
      case '--detach': opts.detach = true; break;
      case '--strict-port': opts.strictPort = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (opts.noOpen) opts.open = false;
  return opts;
}

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

/** Run a command and collect its output. Rejects on spawn failure or timeout. */
function runCommand(cmd, args, { timeoutMs, shell = false }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errOut = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    child.stdout.on('data', (d) => {
      if ((outBytes += d.length) <= 16 * 1024 * 1024) out.push(d);
    });
    child.stderr.on('data', (d) => {
      if ((errBytes += d.length) <= 64 * 1024) errOut.push(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        // With shell:true the direct child is cmd.exe; kill the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
      } else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' }));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') });
    });
  });
}

async function modelsFromOpencode(refresh) {
  const args = ['models', ...(refresh ? ['--refresh'] : [])];
  let result;
  try {
    // On Windows opencode is installed as opencode.cmd, which only resolves through a shell.
    result = await runCommand('opencode', args, { timeoutMs: MODELS_TIMEOUT_MS, shell: process.platform === 'win32' });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('opencode was not found on PATH');
    if (err.code === 'ETIMEDOUT') throw new Error(`\`opencode ${args.join(' ')}\` did not finish within ${MODELS_TIMEOUT_MS / 1000}s`);
    throw new Error(`could not run opencode: ${err.message}`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).pop() || `exit code ${result.code}`;
    throw new Error(`\`opencode ${args.join(' ')}\` failed: ${detail.slice(0, 300)}`);
  }
  const providers = parseModelsOutput(result.stdout);
  if (!countModels(providers)) throw new Error('`opencode models` listed no models (is a provider connected? try `opencode auth login`)');
  return providers;
}

async function modelsFromAnthropic(apiKey) {
  // ANTHROPIC_BASE_URL is honoured the same way the official SDKs honour it.
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/models?limit=1000`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const ids = (Array.isArray(body?.data) ? body.data : [])
    .map((m) => m?.id)
    .filter((id) => typeof id === 'string' && /^\S+$/.test(id))
    .map((id) => `anthropic/${id}`);
  if (!ids.length) throw new Error('the API returned no models');
  return { anthropic: ids };
}

/** The model list, cached in memory until a refresh is asked for. Concurrent callers share one run. */
export function createModelSource() {
  let cache = null;
  let inflight = null;
  const load = async (refresh) => {
    const fetchedAt = new Date().toISOString();
    let reason;
    try {
      return { source: 'opencode', providers: await modelsFromOpencode(refresh), fetchedAt };
    } catch (err) {
      reason = err.message;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        return { source: 'anthropic-api', providers: await modelsFromAnthropic(process.env.ANTHROPIC_API_KEY), fetchedAt, note: reason };
      } catch (err) {
        reason += `; the Anthropic API fallback also failed (${err.message})`;
      }
    }
    return { source: 'none', error: reason, providers: {}, fetchedAt };
  };
  return (refresh = false) => {
    if (inflight) return inflight;
    if (cache && !refresh) return Promise.resolve(cache);
    inflight = load(refresh)
      .then((r) => (cache = r))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function agentsPayload(root) {
  const [agents, global] = await Promise.all([readAgents(root), readGlobalConfig(root)]);
  return { root, agents, global };
}

/**
 * Create (but do not start) the editor server.
 * onIdle/onShutdown default to stopping the process.
 */
export function createEditorServer({ root, idleMinutes = 15, getModels = createModelSource(), onShutdown } = {}) {
  let lastRequest = Date.now();
  let port = 0;
  const server = http.createServer();

  let idleTimer;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(idleTimer);
    server.close(() => (onShutdown ? onShutdown() : process.exit(0)));
    server.closeAllConnections();
  };

  // Idle auto-shutdown; the page pings /api/health every 60s while it is open.
  if (idleMinutes > 0) {
    idleTimer = setInterval(() => {
      if (Date.now() - lastRequest > idleMinutes * 60_000) shutdown();
    }, Math.min(30_000, Math.max(1_000, (idleMinutes * 60_000) / 4)));
    idleTimer.unref();
  }

  server.on('request', async (req, res) => {
    lastRequest = Date.now();
    try {
      // DNS-rebinding guard: a page on evil.example resolved to 127.0.0.1 still sends Host: evil.example.
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Forbidden host');

      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method === 'POST') {
        // CSRF guard: other sites cannot send application/json without a CORS preflight (which we never
        // answer), and browsers always send Origin on cross-site POSTs.
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
          throw new HttpError(403, 'Forbidden origin');
        }
      }

      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /':
        case 'GET /index.html': {
          const html = await readFile(INDEX_FILE);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': html.length,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          });
          res.end(html);
          return;
        }
        case 'GET /favicon.ico':
          res.writeHead(204).end();
          return;
        case 'GET /api/health':
          sendJson(res, 200, { app: APP_ID, root, port, pid: process.pid, idleMinutes });
          return;
        case 'GET /api/agents':
          sendJson(res, 200, await agentsPayload(root));
          return;
        case 'GET /api/models': {
          const refresh = ['1', 'true'].includes(url.searchParams.get('refresh') || '');
          sendJson(res, 200, await getModels(refresh));
          return;
        }
        case 'POST /api/agents': {
          const body = await readJsonBody(req);
          const saved = await applyChanges(root, body);
          sendJson(res, 200, { ok: true, saved, ...(await agentsPayload(root)) });
          return;
        }
        case 'POST /api/shutdown':
          await readJsonBody(req).catch(() => {});
          res.once('finish', () => setImmediate(shutdown));
          sendJson(res, 200, { ok: true });
          return;
        default:
          if (['/', '/index.html', '/api/health', '/api/agents', '/api/models', '/api/shutdown'].includes(url.pathname)) {
            throw new HttpError(405, 'Method not allowed');
          }
          throw new HttpError(404, 'Not found');
      }
    } catch (err) {
      const status = err.status || 500;
      const body = { error: err.message || 'Internal error', ...(err.errors ? { errors: err.errors } : {}), ...(err.extra || {}) };
      if (status === 413) {
        // Stop reading an oversized upload.
        res.once('finish', () => req.destroy());
        sendJson(res, status, body, { Connection: 'close' });
      } else if (!res.headersSent) sendJson(res, status, body);
      else res.destroy();
    }
  });

  return {
    server,
    shutdown,
    get port() {
      return port;
    },
    listen(p) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          port = server.address().port;
          resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, '127.0.0.1');
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Launcher helpers
// ---------------------------------------------------------------------------

const sameRoot = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** What is on this port? { state: 'ours', root } | { state: 'free' } | { state: 'taken' } */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000, headers: { Connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(body?.app === APP_ID ? { state: 'ours', root: body.root } : { state: 'taken' });
        } catch {
          resolve({ state: 'taken' });
        }
      });
      res.on('error', () => resolve({ state: 'taken' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ state: err.code === 'ECONNREFUSED' ? 'free' : 'taken' }));
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** First port from `start` that already runs our editor for this root (reuse) or is free. */
async function findPort(root, start, attempts) {
  for (let p = start; p < start + attempts && p <= 65535; p++) {
    const r = await probe(p);
    if (r.state === 'ours' && sameRoot(r.root, root)) return { port: p, reuse: true };
    if (r.state === 'free' && (await canListen(p))) return { port: p, reuse: false };
  }
  return null;
}

/** Try each launch command in turn. Never throws; resolves true if one of them seems to have worked. */
export async function openBrowser(url) {
  try {
    let procVersion = '';
    if (process.platform === 'linux') {
      try {
        procVersion = readFileSync('/proc/version', 'utf8');
      } catch {}
    }
    const commands = browserCommands(url, { procVersion, hasMntC: existsSync('/mnt/c') });
    for (const c of commands) {
      if (await tryLaunch(c)) return true;
    }
  } catch {}
  return false;
}

function tryLaunch({ cmd, args, options = {}, anyExit = false }) {
  return new Promise((resolve) => {
    let child;
    try {
      // Detached with stdio ignored, so the browser never holds the caller's output pipe open.
      child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...options });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(anyExit || code === 0));
    // Still running after a moment: the launcher is busy opening the page, call it a success.
    const timer = setTimeout(() => done(true), 1500);
  });
}

function editorLine(url) {
  return `Config editor running at ${url} ${RESTART_HINT}`;
}

function writeOut(text) {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

function waitForEditor(port, root, child) {
  return new Promise((resolve) => {
    let exited = false;
    child.once('exit', () => (exited = true));
    child.once('error', () => (exited = true));
    const deadline = Date.now() + START_TIMEOUT_MS;
    const tick = async () => {
      const r = await probe(port);
      if (r.state === 'ours' && sameRoot(r.root, root)) return resolve(true);
      if (exited || Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** --detach: reuse or start a background editor, open the browser, print one line, exit. */
async function launchDetached(opts) {
  let start = opts.port;
  const end = opts.port + PORT_ATTEMPTS;
  while (start < end) {
    const found = await findPort(opts.root, start, end - start);
    if (!found) break;
    let ok = found.reuse;
    if (!ok) {
      const child = spawn(
        process.execPath,
        [SERVER_FILE, '--root', opts.root, '--port', String(found.port), '--no-open', '--strict-port', '--idle-minutes', String(opts.idleMinutes)],
        // stdio 'ignore' matters: opencode waits for the command's stdout to close, so the
        // background server must not inherit it.
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: opts.root },
      );
      ok = await waitForEditor(found.port, opts.root, child);
      child.unref();
    }
    if (ok) {
      const url = `http://127.0.0.1:${found.port}`;
      if (opts.open) await openBrowser(url);
      await writeOut(editorLine(url) + '\n');
      process.exit(0);
    }
    start = found.port + 1; // the child could not bind (a race); try the next port
  }
  await writeOut(`Config editor could not start: no free port between ${opts.port} and ${end - 1}\n`);
  process.exit(1);
}

/** Foreground: serve until Ctrl+C, /api/shutdown or the idle timeout. */
async function runForeground(opts) {
  let port = opts.port;
  if (port !== 0 && !opts.strictPort) {
    const found = await findPort(opts.root, opts.port, PORT_ATTEMPTS);
    if (!found) {
      console.error(`Config editor could not start: no free port between ${opts.port} and ${opts.port + PORT_ATTEMPTS - 1}`);
      process.exit(1);
    }
    if (found.reuse) {
      const url = `http://127.0.0.1:${found.port}`;
      if (opts.open) await openBrowser(url);
      console.log(editorLine(url));
      return;
    }
    port = found.port;
  }
  const editor = createEditorServer({ root: opts.root, idleMinutes: opts.idleMinutes });
  try {
    port = await editor.listen(port);
  } catch (err) {
    console.error(`Config editor could not start on port ${port}: ${err.message}`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}`;
  console.log(editorLine(url));
  if (process.stdout.isTTY) console.log('Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => editor.shutdown());
  if (opts.open && !(await openBrowser(url))) console.log(`Open ${url} in your browser.`);
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!existsSync(path.join(opts.root, '.opencode'))) {
    // In --detach mode stdout is what /config shows, so report there.
    (opts.detach ? console.log : console.error)(`Config editor could not start: no .opencode folder in ${opts.root}`);
    process.exit(1);
  }
  if (opts.detach) await launchDetached(opts);
  else await runForeground(opts);
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.log(`Config editor could not start: ${err.message}`);
    process.exit(1);
  });
}
