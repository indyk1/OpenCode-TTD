#!/usr/bin/env node
// opencode config editor: a small local server that lets a browser page change each
// agent's `model:` and `variant:` in .opencode/agents/*.md. Zero dependencies, Node 20+.
//
//   node .opencode/config-editor/server.mjs --open            foreground, Ctrl+C to stop
//   node .opencode/config-editor/server.mjs --open --detach   start in the background and return (used by /config)
//
// Options: --root <dir>  --port <n> (default 4317)  --open / --no-open  --detach  --idle-minutes <n> (0 = never)
// The launcher, the request guards and opening the browser are shared with the token usage page: ../lib/local-web.mjs.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, applyChanges, countModels, parseModelsOutput, readAgents, readGlobalConfig } from './lib.mjs';
import {
  HttpError,
  checkRequest,
  isEntryPoint,
  launchDetached,
  listenLocal,
  parseLauncherArgs,
  readJsonBody,
  runForeground,
  sendError,
  sendJson,
  startIdleTimer,
} from '../lib/local-web.mjs';

export { openBrowser } from '../lib/local-web.mjs';

const SERVER_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SERVER_FILE);
const INDEX_FILE = path.join(HERE, 'index.html');
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 64 * 1024;
const MODELS_TIMEOUT_MS = 45_000;
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
  return parseLauncherArgs(argv, { defaultRoot: path.resolve(HERE, '..', '..'), defaultPort: DEFAULT_PORT });
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

  let stopIdleTimer = () => {};
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopIdleTimer();
    server.close(() => (onShutdown ? onShutdown() : process.exit(0)));
    server.closeAllConnections();
  };

  // Idle auto-shutdown; the page pings /api/health every 60s while it is open.
  stopIdleTimer = startIdleTimer(idleMinutes, () => lastRequest, shutdown);

  server.on('request', async (req, res) => {
    lastRequest = Date.now();
    try {
      // Host check (DNS rebinding) and, on POST, the JSON-only and same-origin checks (cross-site requests).
      const url = checkRequest(req, port);

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
          const body = await readJsonBody(req, MAX_BODY_BYTES);
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
      sendError(req, res, err);
    }
  });

  return {
    server,
    shutdown,
    get port() {
      return port;
    },
    async listen(p) {
      port = await listenLocal(server, p);
      return port;
    },
  };
}

// ---------------------------------------------------------------------------
// Launcher (shared with the token usage page: ../lib/local-web.mjs)
// ---------------------------------------------------------------------------

function editorLine(url) {
  return `Config editor running at ${url} ${RESTART_HINT}`;
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
  const launch = {
    appId: APP_ID,
    name: 'Config editor',
    root: opts.root,
    port: opts.port,
    idleMinutes: opts.idleMinutes,
    open: opts.open,
    runningLine: editorLine,
  };
  if (opts.detach) await launchDetached({ ...launch, serverFile: SERVER_FILE });
  else {
    await runForeground({
      ...launch,
      strictPort: opts.strictPort,
      create: () => createEditorServer({ root: opts.root, idleMinutes: opts.idleMinutes }),
    });
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.log(`Config editor could not start: ${err.message}`);
    process.exit(1);
  });
}
