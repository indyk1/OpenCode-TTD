// Plumbing shared by the small local web pages under .opencode/ (the /config editor, the /costings token usage
// page and the /diagram and /classes diagrams): request guards, JSON helpers, port finding, opening the browser,
// idle shutdown, and the detached launcher that slash commands use. Node built-ins only - no package.json may live
// under .opencode/, because opencode bun-installs .opencode/package.json.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PORT_ATTEMPTS = 10;
const START_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(res, status, body, headers = {}) {
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

/** Send an error as JSON. An oversized upload also closes the connection. */
export function sendError(req, res, err) {
  const status = err.status || 500;
  const body = { error: err.message || 'Internal error', ...(err.errors ? { errors: err.errors } : {}), ...(err.extra || {}) };
  if (status === 413) {
    // Stop reading an oversized upload.
    res.once('finish', () => req.destroy());
    sendJson(res, status, body, { Connection: 'close' });
  } else if (!res.headersSent) sendJson(res, status, body);
  else res.destroy();
}

export function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
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

/**
 * Accept only requests from our own page and return the request URL. Throws HttpError for a foreign Host
 * (DNS rebinding) and, on POST, for a body that is not JSON or a foreign Origin (cross-site requests).
 */
export function checkRequest(req, port) {
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
  return url;
}

/** Call onIdle after `idleMinutes` without a request (0 = never). Returns a function that stops the timer. */
export function startIdleTimer(idleMinutes, lastRequest, onIdle) {
  if (!(idleMinutes > 0)) return () => {};
  const timer = setInterval(() => {
    if (Date.now() - lastRequest() > idleMinutes * 60_000) onIdle();
  }, Math.min(30_000, Math.max(1_000, (idleMinutes * 60_000) / 4)));
  timer.unref();
  return () => clearInterval(timer);
}

/** Listen on 127.0.0.1 only. Resolves with the port actually bound (useful with port 0). */
export function listenLocal(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * The options every local page takes: --root, --port, --idle-minutes, --open, --no-open, --detach, -h, plus the
 * internal --strict-port. `valueFlags` adds page-specific options that take a value, e.g. { '--csv': 'csv' }.
 */
export function parseLauncherArgs(argv, { defaultRoot, defaultPort, valueFlags = {} }) {
  const opts = {
    root: defaultRoot,
    port: defaultPort,
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
      default:
        if (Object.hasOwn(valueFlags, arg)) opts[valueFlags[arg]] = value(arg);
        else throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (opts.noOpen) opts.open = false;
  return opts;
}

// ---------------------------------------------------------------------------
// Opening the browser
// ---------------------------------------------------------------------------

export function isWsl({ platform = process.platform, env = process.env, procVersion = '' } = {}) {
  return platform === 'linux' && (Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(procVersion));
}

/**
 * The commands to try, in order, to open `url` in the user's browser.
 * Each is { cmd, args, options, anyExit } where anyExit means "a non-zero exit still counts as success"
 * (explorer.exe returns 1 even when it opened the page).
 */
export function browserCommands(url, { platform = process.platform, env = process.env, procVersion = '', hasMntC = true } = {}) {
  if (platform === 'win32') {
    // `start` treats the first quoted argument as a window title, hence the empty "".
    return [{ cmd: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } }];
  }
  if (platform === 'darwin') return [{ cmd: 'open', args: [url] }];
  if (isWsl({ platform, env, procVersion })) {
    return [
      { cmd: 'wslview', args: [url] },
      // Running cmd.exe from a Linux directory prints a "UNC paths are not supported" warning; /mnt/c avoids it.
      { cmd: 'cmd.exe', args: ['/c', 'start', '', url], options: hasMntC ? { cwd: '/mnt/c' } : {} },
      { cmd: 'explorer.exe', args: [url], anyExit: true },
    ];
  }
  return [{ cmd: 'xdg-open', args: [url] }];
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

// ---------------------------------------------------------------------------
// Ports and the launcher
// ---------------------------------------------------------------------------

export const sameRoot = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** What is on this port? { state: 'ours', root } (a server of `appId`) | { state: 'free' } | { state: 'taken' } */
export function probe(port, appId) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000, headers: { Connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(body?.app === appId ? { state: 'ours', root: body.root } : { state: 'taken' });
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

/** First port from `start` that already runs this app for `root` (reuse) or is free. */
export async function findPort({ appId, root, start, attempts = PORT_ATTEMPTS }) {
  for (let p = start; p < start + attempts && p <= 65535; p++) {
    const r = await probe(p, appId);
    if (r.state === 'ours' && sameRoot(r.root, root)) return { port: p, reuse: true };
    if (r.state === 'free' && (await canListen(p))) return { port: p, reuse: false };
  }
  return null;
}

export function writeOut(text) {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

function waitForServer(port, appId, root, child) {
  return new Promise((resolve) => {
    let exited = false;
    child.once('exit', () => (exited = true));
    child.once('error', () => (exited = true));
    const deadline = Date.now() + START_TIMEOUT_MS;
    const tick = async () => {
      const r = await probe(port, appId);
      if (r.state === 'ours' && sameRoot(r.root, root)) return resolve(true);
      if (exited || Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * --detach: reuse this app's server for `root`, or start `serverFile` in the background on a free port; open the
 * browser, print `runningLine(url)` and exit. Slash commands show that one line. `urlPath` (e.g. '/classes') is
 * added to the address that is opened and printed.
 */
export async function launchDetached({ appId, name, serverFile, root, port, idleMinutes, open, runningLine, urlPath = '' }) {
  let start = port;
  const end = port + PORT_ATTEMPTS;
  while (start < end) {
    const found = await findPort({ appId, root, start, attempts: end - start });
    if (!found) break;
    let ok = found.reuse;
    if (!ok) {
      const child = spawn(
        process.execPath,
        [serverFile, '--root', root, '--port', String(found.port), '--no-open', '--strict-port', '--idle-minutes', String(idleMinutes)],
        // stdio 'ignore' matters: opencode waits for the command's stdout to close, so the
        // background server must not inherit it.
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: root },
      );
      ok = await waitForServer(found.port, appId, root, child);
      child.unref();
    }
    if (ok) {
      const url = `http://127.0.0.1:${found.port}${urlPath}`;
      if (open) await openBrowser(url);
      await writeOut(runningLine(url) + '\n');
      process.exit(0);
    }
    start = found.port + 1; // the child could not bind (a race); try the next port
  }
  await writeOut(`${name} could not start: no free port between ${port} and ${end - 1}\n`);
  process.exit(1);
}

/** Foreground: reuse a running server for `root`, or serve `create()` until Ctrl+C, /api/shutdown or the idle timeout. */
export async function runForeground({ appId, name, root, port, strictPort, open, runningLine, create, urlPath = '' }) {
  if (port !== 0 && !strictPort) {
    const found = await findPort({ appId, root, start: port });
    if (!found) {
      console.error(`${name} could not start: no free port between ${port} and ${port + PORT_ATTEMPTS - 1}`);
      process.exit(1);
    }
    if (found.reuse) {
      const url = `http://127.0.0.1:${found.port}${urlPath}`;
      if (open) await openBrowser(url);
      console.log(runningLine(url));
      return;
    }
    port = found.port;
  }
  const app = create();
  try {
    port = await app.listen(port);
  } catch (err) {
    console.error(`${name} could not start on port ${port}: ${err.message}`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}${urlPath}`;
  console.log(runningLine(url));
  if (process.stdout.isTTY) console.log('Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.shutdown());
  if (open && !(await openBrowser(url))) console.log(`Open ${url} in your browser.`);
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isEntryPoint(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
